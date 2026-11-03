// Types for roles.mjs, which the TypeScript portals import (scoutbox-club, scoutbox-grassroots).
export declare const LEAD_ROLE_PATTERN: RegExp;
export declare const isLeadRole: (role: string | null | undefined) => boolean;
export declare const isLeadUser: (user: { role?: string | null } | null | undefined) => boolean;
export declare const FINANCE_ROLE_PATTERN: RegExp;
export declare const isFinanceRole: (role: string | null | undefined) => boolean;
export declare const isFinanceUser: (user: { role?: string | null } | null | undefined) => boolean;
