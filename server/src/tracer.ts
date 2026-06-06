/**
 * OTel-based tracer for measuring loop startup latency.
 *
 * Initialization is controlled by environment:
 *   - OTEL_TRACES_EXPORTER=console  → ConsoleSpanExporter (stderr)
 *   - OTEL_TRACES_EXPORTER=otlp     → OTLP HTTP exporter (Jaeger etc.)
 *   - unset / "none"                → noop (zero overhead)
 *
 * Call sites use the standard @opentelemetry/api — this module only
 * handles SDK bootstrap. Import it at the top of the entry point
 * (before any application code) so spans from the first request are
 * captured.
 */
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api"
import { Resource } from "@opentelemetry/resources"

const exporterName = (process.env.OTEL_TRACES_EXPORTER ?? "none").toLowerCase()

if (exporterName !== "none") {
  const resource = new Resource({ "service.name": "loopat-server" })
  const provider = new NodeTracerProvider({ resource })

  if (exporterName === "console") {
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()))
  } else if (exporterName === "otlp") {
    provider.addSpanProcessor(
      new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
        }),
      ),
    )
  }

  provider.register()
}

export const tracer: Tracer = trace.getTracer("loopat", "0.1.0")

export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span)
    } catch (e) {
      span.recordException(e as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message })
      throw e
    } finally {
      span.end()
    }
  })
}
