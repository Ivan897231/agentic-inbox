// Typed builders without needing `convex codegen` (which requires a live deployment).
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import { internalMutationGeneric, internalQueryGeneric, mutationGeneric, queryGeneric } from "convex/server";
import type schema from "./schema";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export const query = queryGeneric as QueryBuilder<DataModel, "public">;
export const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
export const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
