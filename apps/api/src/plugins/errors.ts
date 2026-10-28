// Every error leaves the API as RFC 9457 problem+json with a `code` (BACKEND_PLAN §8.1, ARCHITECTURE §5).
// Only AppError details reach the client; any other error's message stays out of responses and logs.
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import {
  AppError,
  type ErrorCode,
  isAppError,
  PROBLEM_CONTENT_TYPE,
  type ProblemField,
  ProblemSchema,
} from "@mp/contracts";
import { stripQuery } from "../lib/url";

const FIELD_SOURCES = new Set<ProblemField["in"]>(["body", "querystring", "params", "headers"]);

interface ValidationIssue {
  instancePath?: string;
  message?: string;
}

function toFields(validation: readonly ValidationIssue[], context: string | undefined): ProblemField[] {
  const where = (FIELD_SOURCES.has(context as ProblemField["in"]) ? context : "body") as ProblemField["in"];
  return validation.map((issue) => ({
    in: where,
    path: (issue.instancePath ?? "").split("/").filter(Boolean).join("."),
    message: issue.message ?? "Invalid value",
  }));
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "validation_failed",
  428: "precondition_required",
  429: "rate_limited",
};

/** Maps anything thrown inside a request to an AppError. Unknown errors become a generic 500. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (hasZodFastifySchemaValidationErrors(err)) {
    const context = (err as { validationContext?: string }).validationContext;
    return new AppError("validation_failed", 400, "The request has invalid fields.", {
      fields: toFields(err.validation, context),
      cause: err,
    });
  }

  const fe = err as Partial<FastifyError> | undefined;
  if (fe && Array.isArray(fe.validation)) {
    return new AppError("validation_failed", 400, "The request has invalid fields.", {
      fields: toFields(fe.validation, fe.validationContext),
      cause: err,
    });
  }

  const status = typeof fe?.statusCode === "number" ? fe.statusCode : 500;
  if (status >= 400 && status < 500) {
    // Fastify's own client errors (bad JSON, wrong content type, body too large). Their messages can echo
    // request input, so the detail stays generic.
    if (status === 400) return new AppError("validation_failed", 400, "The request body is malformed.");
    return new AppError(STATUS_CODES[status] ?? "bad_request", status, undefined, { cause: err });
  }
  return new AppError("internal_error", 500, "Something went wrong. Try again later.", { cause: err });
}

/** Sends `err` as problem+json. The body is a string so no route response schema re-serializes it. */
export function sendProblem(request: FastifyRequest, reply: FastifyReply, err: AppError): FastifyReply {
  const problem = err.toProblem({ instance: stripQuery(request.url), requestId: request.id });
  return reply
    .code(err.status)
    .headers(err.headers)
    .type(`${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
    .send(JSON.stringify(problem));
}

const ERROR_RESPONSES = {
  "4XX": {
    description: "Client error (RFC 9457 problem details)",
    content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } },
  },
  "5XX": {
    description: "Server error (RFC 9457 problem details)",
    content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } },
  },
};

const errorsPlugin: FastifyPluginAsync = async (app) => {
  // Document problem responses on every route that declares a schema, so the generated client types them.
  app.addHook("onRoute", (route: RouteOptions) => {
    if (!route.schema || route.schema.hide) return;
    route.schema.response = { ...ERROR_RESPONSES, ...(route.schema.response as object | undefined) };
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    const appError = toAppError(err);
    if (appError.status >= 500) {
      request.log.error({ err, errorCode: appError.code }, "request failed");
    } else {
      request.log.info({ errorCode: appError.code, statusCode: appError.status }, "request rejected");
    }
    return sendProblem(request, reply, appError);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, new AppError("not_found", 404, "No route matches this request.")),
  );
};

export const errors = fp(errorsPlugin, { name: "mp-errors" });
