import { NextResponse } from "next/server";
import {
  AuthenticationError,
  AuthorizationError,
} from "@/lib/auth";
import { ExceptionTransitionError } from "@/lib/exceptions/service";
import { ImportConflictError, ImportInputError } from "@/lib/imports/service";
import { MappingSuggestionInputError } from "@/lib/imports/ai-mapping";
import { ReconciliationConflictError } from "@/lib/reconciliation/service";

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (
    error instanceof ImportConflictError ||
    error instanceof ReconciliationConflictError ||
    error instanceof ExceptionTransitionError
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof ImportInputError ||
    error instanceof ExceptionTransitionError ||
    error instanceof MappingSuggestionInputError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error("API operation failed.", error);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
