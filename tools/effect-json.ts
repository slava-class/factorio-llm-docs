import { Either, Schema } from "effect";

export function decodeJsonOrThrow<A>(
  schema: Schema.Schema<A, unknown, never>,
  jsonText: string,
  label: string,
): A {
  const decode = Schema.decodeUnknownEither(Schema.parseJson(schema));
  const result = decode(jsonText);
  if (Either.isLeft(result)) {
    throw new Error(`Failed to decode ${label}:\n${result.left.message}`);
  }
  return result.right;
}

const preserve = { parseOptions: { onExcessProperty: "preserve" as const } };

export const NamedDocEntrySchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
}).annotations(preserve);

export const RuntimeApiSchema = Schema.Struct({
  application_version: Schema.String,
  classes: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  concepts: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  events: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  defines: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  global_functions: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  global_objects: Schema.optional(Schema.Array(NamedDocEntrySchema)),
}).annotations(preserve);

export const PrototypeApiSchema = Schema.Struct({
  application_version: Schema.String,
  prototypes: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  types: Schema.optional(Schema.Array(NamedDocEntrySchema)),
  defines: Schema.optional(Schema.Array(NamedDocEntrySchema)),
}).annotations(preserve);

export const ManifestSchema = Schema.Struct({
  version: Schema.String,
  generated_at: Schema.String,
  outputs: Schema.Struct({
    markdown_root: Schema.String,
    chunks_jsonl: Schema.String,
  }).annotations(preserve),
  counts: Schema.Struct({
    runtime: Schema.Struct({
      classes: Schema.Number,
      concepts: Schema.Number,
      events: Schema.Number,
      defines: Schema.Number,
      global_functions: Schema.Number,
      global_objects: Schema.Number,
    }).annotations(preserve),
    prototype: Schema.Struct({
      prototypes: Schema.Number,
      types: Schema.Number,
      defines: Schema.Number,
    }).annotations(preserve),
    auxiliary: Schema.Struct({
      pages: Schema.Number,
    }).annotations(preserve),
    chunks: Schema.Number,
  }).annotations(preserve),
}).annotations(preserve);

export const SymbolEntrySchema = Schema.Struct({
  id: Schema.String,
  stage: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  member: Schema.optional(Schema.String),
  relPath: Schema.String,
  anchor: Schema.optional(Schema.String),
}).annotations(preserve);

export const SymbolsSchema = Schema.Record({
  key: Schema.String,
  value: SymbolEntrySchema,
});

export const ChunkRecordSchema = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  stage: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  member: Schema.optional(Schema.String),
  relPath: Schema.optional(Schema.String),
  anchor: Schema.optional(Schema.String),
  call: Schema.optional(Schema.String),
  takes_table: Schema.optional(Schema.Boolean),
  table_optional: Schema.optional(Schema.Boolean),
  text: Schema.String,
}).annotations(preserve);
