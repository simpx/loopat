/**
 * OpenAPI 3.1 schema for the v1 Loop API.
 *
 * Source of truth is `docs/api-v1.md`. This file mirrors that contract in
 * a machine-readable form so the interactive docs (Scalar) can render it.
 *
 * Keep these two in sync when changing the API — spec doc first, then this.
 */

export const v1OpenApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Loopat Loop API",
    version: "1.0.0",
    description: [
      "External API for creating and driving loops. The same surface powers ",
      "the loopat web chat UI — bot frameworks and the web app speak the same ",
      "protocol.",
      "",
      "**Auth**: pass `Authorization: Bearer la_<token>` for external programs, ",
      "or a `loopat_session` cookie for same-origin web requests.",
      "",
      "**Scope**: v1 only covers chat conversation. Operator features (queue, ",
      "goal, provider, archive admin flags) stay on internal endpoints; see the ",
      "full spec at `docs/api-v1.md`.",
    ].join("\n"),
  },
  servers: [{ url: "/api/v1", description: "current host, v1 prefix" }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "la_<48 hex>",
        description: "External programs. Token from Settings → API Tokens.",
      },
      CookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "loopat_session",
        description: "Web same-origin requests; set by /api/auth/login.",
      },
    },
    schemas: {
      Loop: {
        type: "object",
        required: ["id", "title", "created_at", "created_by", "archived", "metadata", "profiles", "vault"],
        properties: {
          id: { type: "string", example: "loop_3a91ce5e-9c2f-4f0a-bcc9-7c7e..." },
          title: { type: "string", maxLength: 200 },
          created_at: { type: "string", format: "date-time" },
          created_by: { type: "string", example: "alice" },
          archived: { type: "boolean" },
          archived_at: { type: "string", format: "date-time", nullable: true },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Caller-supplied k/v, ≤16 KB JSON-stringified. Not visible to the agent.",
          },
          profiles: { type: "array", items: { type: "string" } },
          vault: { type: "string", example: "default" },
          repo: { type: "string", nullable: true, example: "myproject" },
          busy: { type: "boolean", description: "Only on GET /loops/{id}" },
          queue_depth: { type: "integer", description: "Only on GET /loops/{id}" },
          turn_count: { type: "integer", description: "Only on GET /loops/{id}" },
          current_turn: {
            type: "object",
            nullable: true,
            description: "Present iff busy=true",
            properties: {
              turn_id: { type: "string", nullable: true },
              started_at: { type: "string", format: "date-time", nullable: true },
              pending_choice_id: { type: "string", nullable: true },
            },
          },
        },
      },
      LoopList: {
        type: "object",
        required: ["data", "has_more"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Loop" } },
          first_id: { type: "string", nullable: true },
          last_id: { type: "string", nullable: true },
          has_more: { type: "boolean" },
        },
      },
      ApiTokenView: {
        type: "object",
        required: ["tokenId", "label", "createdAt"],
        properties: {
          tokenId: { type: "string", example: "tok_a1b2c3d4e5f6" },
          label: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          lastUsedAt: { type: "string", format: "date-time" },
        },
      },
      ApiTokenCreated: {
        type: "object",
        required: ["tokenId", "token", "label", "createdAt"],
        properties: {
          tokenId: { type: "string" },
          token: {
            type: "string",
            description: "Bearer token plaintext — only returned once at creation.",
            example: "la_a1b2c3...",
          },
          label: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["type", "code", "message"],
            properties: {
              type: {
                type: "string",
                enum: [
                  "authentication_error",
                  "permission_error",
                  "invalid_request_error",
                  "not_found_error",
                  "conflict_error",
                  "rate_limit_error",
                  "internal_error",
                ],
              },
              code: { type: "string", example: "loop_not_found" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }, { CookieAuth: [] }],
  paths: {
    "/me/tokens": {
      post: {
        summary: "Create an API token",
        description: "Cookie-only (web Settings UI). Bots cannot self-issue tokens.",
        security: [{ CookieAuth: [] }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { label: { type: "string", default: "default" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Token created. Plaintext returned once.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ApiTokenCreated" } },
            },
          },
          "401": { description: "Session required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      get: {
        summary: "List my API tokens",
        security: [{ CookieAuth: [] }],
        responses: {
          "200": {
            description: "Token list (plaintext omitted)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { tokens: { type: "array", items: { $ref: "#/components/schemas/ApiTokenView" } } },
                },
              },
            },
          },
        },
      },
    },
    "/me/tokens/{tokenId}": {
      delete: {
        summary: "Revoke an API token",
        security: [{ CookieAuth: [] }],
        parameters: [
          { name: "tokenId", in: "path", required: true, schema: { type: "string" }, example: "tok_a1b2c3..." },
        ],
        responses: {
          "204": { description: "Revoked" },
          "404": { description: "Not found" },
        },
      },
    },
    "/loops": {
      post: {
        summary: "Create a loop",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", default: "untitled", maxLength: 200 },
                  metadata: { type: "object", additionalProperties: { type: "string" } },
                  profiles: { type: "array", items: { type: "string" } },
                  vault: { type: "string", default: "default" },
                  repo: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Loop created", content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } } },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      get: {
        summary: "List my loops",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "after", in: "query", schema: { type: "string" }, description: "Cursor: returns loops older than this id" },
          { name: "before", in: "query", schema: { type: "string" }, description: "Cursor: returns loops newer than this id" },
          { name: "archived", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": { description: "Loop list", content: { "application/json": { schema: { $ref: "#/components/schemas/LoopList" } } } },
        },
      },
    },
    "/loops/{id}": {
      get: {
        summary: "Get a loop",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Loop with runtime state", content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } } },
          "403": { description: "Not loop owner", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        summary: "Archive a loop",
        description: "Soft-delete. Sandbox is killed, meta retained. Unarchive/hard-delete are web-only.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Archived" },
          "403": { description: "Not loop owner" },
          "404": { description: "Not found" },
        },
      },
    },
    "/loops/{id}/messages": {
      post: {
        summary: "Send a message and stream the turn (SSE)",
        description: [
          "Returns `text/event-stream`. See the SSE event vocabulary in `docs/api-v1.md`.",
          "Closing the connection does **not** cancel the turn. Reconnect using the same",
          "`Idempotency-Key` to replay buffered events and attach to the live stream.",
        ].join(" "),
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", schema: { type: "string", maxLength: 256 } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: { type: "string", maxLength: 1048576 },
                  permission_mode: {
                    type: "string",
                    enum: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"],
                    description: "Override the loop's current permission mode for this turn.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "SSE stream. Event vocabulary: queued, started, assistant_delta, thinking_delta, tool_call, tool_result, requires_choice, choice_resolved, done, interrupted, error, ping, sdk_message (web-internal).",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "409": { description: "Idempotency-Key reused with different body", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/loops/{id}/events": {
      get: {
        summary: "Watch a loop's events (read-only SSE)",
        description: "Attach to live events without sending a message. Useful for reconnect and passive observation.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "SSE stream. Same vocabulary as POST /messages, prefixed by `event: snapshot` if a turn is already running.",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/loops/{id}/choices/{choiceId}": {
      post: {
        summary: "Answer a choice (permission or question)",
        description: "Unblocks an agent that emitted `requires_choice`. Body shape depends on the choice kind.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "choiceId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    title: "Permission",
                    type: "object",
                    required: ["allow"],
                    properties: { allow: { type: "boolean" } },
                  },
                  {
                    title: "Question",
                    type: "object",
                    required: ["answers"],
                    properties: {
                      answers: { type: "object", additionalProperties: { type: "string" } },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "202": { description: "Choice resolved" },
          "400": { description: "Invalid body shape" },
          "404": { description: "Choice not pending or already answered" },
        },
      },
    },
    "/loops/{id}/interrupt": {
      post: {
        summary: "Cancel the current turn",
        description: "Open SSE streams receive `event: interrupted` and close.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "202": { description: "Interrupted" },
        },
      },
    },
  },
} as const
