%% `platform/store`'s queries: sqlight's `query`, with a statement cache, fetched in batches on a normal scheduler
%% unless a statement's steps have shown themselves to be slow. Gleam can't do this: it needs esqlite's statement
%% handles and the `fetchmany` NIFs that `vendor/esqlite.patch` adds, which sqlight doesn't expose.
%%
%% Why not sqlight's own `query`: it prepares every statement on every call, and esqlite's `fetchall` calls `step`
%% once per row on a dirty I/O scheduler, so every row pays two scheduler switches and every reader contends for the
%% dirty schedulers' one run queue (a point lookup: about 13 us against Node's 3; reads stopped scaling past one
%% connection). `fetchmany` on a normal scheduler takes as many rows as it can step in half a millisecond in one
%% call (a point lookup: about 4 us), and the store calls it again until the statement is done, so a large result
%% never holds a normal scheduler for long. Building rows on a normal scheduler is also what lets large results
%% scale: built in one call on a dirty scheduler, 10,000 rows took 11 ms alone and 16 such calls at once managed
%% only 20 a second between them, as the dirty schedulers contend for a shared allocator; in batches on normal
%% schedulers the same 16 managed 360 a second on 6 cores.
%%
%% A batch whose stepping took over a millisecond met a single slow step (an aggregate over a large table, say,
%% which produces its one row late), and a NIF on a normal scheduler should not run that long: the statement's next
%% batch, and its next run, use `fetchmany_dirty`. A dirty batch that stepped quickly moves it back, so a statement
%% that was slow once (a cold page cache) doesn't stay dirty. The time is the NIF's own, not counting a wait for a
%% scheduler.
%%
%% The cache is an ETS table owned by the writer's process (`new_cache/0`), keyed by connection and SQL text. A
%% statement is only ever run by the process using its connection at the time (a reader's process, or the unit's
%% process on the writer's connection, one unit at a time), so a cached statement is never stepped from two
%% processes at once.
-module(scoutbox_store_ffi).
-export([new_cache/0, query/4, runs_dirty/3]).

%% How long (microseconds) one fetchmany call steps before it returns the rows it has.
-define(BATCH_US, 500).
%% A batch that stepped for longer than this (microseconds) met a slow step: the next batch runs dirty.
-define(LONG_BATCH_US, 1000).
%% Past this many cached statements (all connections together) the cache starts again.
-define(CACHE_LIMIT, 4096).
%% A run that meets a lock (SQLITE_BUSY) is retried this many times, 1 ms apart: the 5 s `busy_timeout` the
%% connections used to have, waited out in Erlang, where a sleep holds no scheduler.
-define(BUSY_RETRIES, 5000).
-define(SQLITE_BUSY, 5).

new_cache() ->
    ets:new(scoutbox_statements, [set, public, {read_concurrency, true}]).

%% sqlight's `query`, with its result: {ok, Rows} with each row a tuple, or {error, SqlightError}.
query(Cache, Conn, Sql, Args) ->
    Key = {Conn, Sql},
    Arity = length(Args),
    case ets:lookup(Cache, Key) of
        [{_, Stmt, Arity, Mode}] ->
            run(Cache, Key, Conn, Stmt, Args, Mode);
        [{_, _, Expected, _}] ->
            %% A reset statement keeps its last bindings, so binding too few arguments would quietly run with the
            %% previous call's values (a fresh statement would bind NULL). One SQL text always takes one count.
            Message = iolist_to_binary(io_lib:format("expected ~p arguments, got ~p", [Expected, Arity])),
            {error, {sqlight_error, generic_error, Message, -1}};
        [] ->
            case esqlite3:prepare(Conn, Sql, [persistent]) of
                {ok, Stmt} ->
                    case ets:info(Cache, size) >= ?CACHE_LIMIT of
                        true -> ets:delete_all_objects(Cache);
                        false -> ok
                    end,
                    ets:insert(Cache, {Key, Stmt, Arity, normal}),
                    run(Cache, Key, Conn, Stmt, Args, normal);
                {error, Code} ->
                    to_error(Conn, Code)
            end
    end.

run(Cache, Key, Conn, Stmt, Args, Mode) ->
    Ref = statement_ref(Stmt),
    %% A statement left mid-step (its caller crashed between batches) can't be bound until it is reset; on one that
    %% finished, reset does nothing.
    _ = esqlite3_nif:reset(Ref),
    case esqlite3:bind(Stmt, Args) of
        ok -> fetch(Cache, Key, Conn, Ref, Mode, [], ?BUSY_RETRIES);
        {error, Code} -> to_error(Conn, Code)
    end.

%% Batches until the statement is done; `Acc` holds the batches so far, newest first.
fetch(Cache, Key, Conn, Ref, Mode, Acc, Retries) ->
    Result =
        case Mode of
            normal -> esqlite3_nif:fetchmany(Ref, ?BATCH_US);
            dirty -> esqlite3_nif:fetchmany_dirty(Ref, ?BATCH_US)
        end,
    case Result of
        {Status, Rows, Micros} ->
            Next =
                case {Micros > ?LONG_BATCH_US, Rows, Acc} of
                    {true, _, _} -> dirty;
                    %% The empty last call after a batch that ran out of time only found the statement done: it
                    %% says nothing about how long a step takes, so the mode stands.
                    {false, [], [_ | _]} -> Mode;
                    {false, _, _} -> normal
                end,
            case Next =:= Mode of
                true -> ok;
                false -> ets:update_element(Cache, Key, {4, Next})
            end,
            case Status of
                done -> {ok, lists:append(lists:reverse([Rows | Acc]))};
                more -> fetch(Cache, Key, Conn, Ref, Next, [Rows | Acc], Retries)
            end;
        {error, Code} when Code band 16#ff =:= ?SQLITE_BUSY, Retries > 0 ->
            %% fetchmany reset the statement and its bindings stand, so it runs again from the start, without the
            %% rows of any batch before.
            timer:sleep(1),
            fetch(Cache, Key, Conn, Ref, Mode, [], Retries - 1);
        {error, Code} ->
            to_error(Conn, Code)
    end.

%% For tests: whether `Sql` on this connection now runs on the dirty scheduler.
runs_dirty(Cache, Conn, Sql) ->
    case ets:match(Cache, {{Conn, Sql}, '_', '_', '$1'}) of
        [[dirty] | _] -> true;
        _ -> false
    end.

%% esqlite3's statement record, `#esqlite3_stmt{stmt = Ref}`: the NIFs take the reference inside it.
statement_ref({esqlite3_stmt, Ref}) -> Ref.

to_error(Conn, Code) ->
    #{errmsg := Message, error_offset := Offset} = esqlite3:error_info(Conn),
    {error, {sqlight_error, sqlight:error_code_from_int(Code), Message, Offset}}.
