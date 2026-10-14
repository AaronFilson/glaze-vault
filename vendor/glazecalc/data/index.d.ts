// Types for index.js, which loads the standard records shipped in this folder.

/** The collections that have standard records: materials, additives and advice. */
export declare const COLLECTIONS: readonly string[];

/** The standard documents for one collection, as stored (ids are ObjectIds). */
export declare function load<T = Record<string, unknown>>(collection: string): T[];
