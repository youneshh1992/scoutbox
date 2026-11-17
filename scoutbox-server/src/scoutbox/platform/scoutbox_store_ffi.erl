%% `platform/store`'s queries: sqlight's `query`, with a statement cache, and run on a normal scheduler unless a
%% statement has shown itself to be long. Gleam can't do this: it needs esqlite's statement handles and the
%% `fetchall` NIFs that `vendor/esqlite.patch` adds, which sqlight doesn't expose.
%%
%% Why not sqlight's own `query`: it prepares every statement on every call, and esqlite's `fetchall` calls `step`
%% once per row on a dirty I/O scheduler, so every row pays two scheduler switches and every reader contends for the
%% dirty schedulers' one run queue (a point lookup: about 13 us against Node's 3; reads stopped scaling past one
%% connection). `fetchall` on a normal scheduler takes all the rows in one call (about 4 us). A NIF on a normal
%% scheduler should return within about a millisecond, though, so a statement whose run took longer runs on
%% `fetchall_dirty` from then on.
%%
%% The cache is an ETS table owned by the writer's process (`new_cache/0`), keyed by connection and SQL text. A
%% statement is only ever run by the process using its connection at the time (a reader's process, or the unit's
%% process on the writer's connection, one unit at a time), so a cached statement is never stepped from two
%% processes at once.
-module(scoutbox_store_ffi).
-export([new_cache/0, query/4, runs_dirty/3]).

%% A statement whose run took longer than this (microseconds) moves to the dirty scheduler for good.
-define(LONG_RUN_US, 1000).
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
    case esqlite3:bind(Stmt, Args) of
        ok -> fetch(Cache, Key, Conn, statement_ref(Stmt), Mode, ?BUSY_RETRIES);
        {error, Code} -> to_error(Conn, Code)
    end.

fetch(Cache, Key, Conn, Ref, Mode, Retries) ->
    Result =
        case Mode of
            dirty ->
                esqlite3_nif:fetchall_dirty(Ref);
            normal ->
                Started = erlang:monotonic_time(microsecond),
                R = esqlite3_nif:fetchall(Ref),
                case erlang:monotonic_time(microsecond) - Started > ?LONG_RUN_US of
                    true -> ets:update_element(Cache, Key, {4, dirty});
                    false -> ok
                end,
                R
        end,
    case Result of
        {ok, Rows} ->
            {ok, Rows};
        {error, Code} when Code band 16#ff =:= ?SQLITE_BUSY, Retries > 0 ->
            %% fetchall reset the statement and its bindings stand, so it runs again from the start.
            timer:sleep(1),
            fetch(Cache, Key, Conn, Ref, Mode, Retries - 1);
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
