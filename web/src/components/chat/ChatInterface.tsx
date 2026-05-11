import type { FC } from "react";
import {
  ThreadPrimitive,
  AuiIf,
} from "@assistant-ui/react";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import Composer from "./Composer";
import AskUserQuestionRenderer from "./AskUserQuestionRenderer";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import ErrorBoundary from "./ErrorBoundary";

/* ─── Welcome screen ─── */

const ThreadWelcome: FC = () => {
  return (
    <div className="my-auto flex grow flex-col">
      <div className="flex w-full grow flex-col items-center justify-center">
        <div className="flex size-full flex-col justify-center px-4">
          <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-semibold text-2xl text-gray-900 duration-200">
            Hello there!
          </h1>
          <p className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-gray-500 text-xl delay-75 duration-200">
            How can I help you today?
          </p>
        </div>
      </div>
    </div>
  );
};

/* ─── Chat Interface ─── */

export default function ChatInterface() {
  const { questions, sendAnswers } = useLoopRuntimeExtra();

  // Convert ReadonlyMap entries to array (safe for iteration)
  const questionEntries = questions.size > 0
    ? Array.from(questions.entries())
    : [];

  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-white"
      style={
        {
          "--thread-max-width": "44rem",
        } as React.CSSProperties
      }
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-3 pt-4">
          {/* Empty state */}
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <ThreadWelcome />
          </AuiIf>

          {/* Message list */}
          <div className="mb-10 flex flex-col gap-4">
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? (
                  <UserMessage />
                ) : (
                  <AssistantMessage />
                )
              }
            </ThreadPrimitive.Messages>
          </div>

          {/* Sticky footer with questions + composer */}
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto bg-gradient-to-t from-white via-white to-transparent pt-4 pb-4 md:pb-6">
            {/* Pending questions (AskUserQuestion tool) — fixed above input */}
            {questionEntries.length > 0 && (
              <ErrorBoundary name="QuestionsPanel">
                <div className="mb-3 space-y-3">
                  {questionEntries.map(([toolUseId, qs]) =>
                    Array.isArray(qs) && qs.length > 0 ? (
                      <div
                        key={toolUseId}
                        className="rounded-lg border border-violet-200 bg-white p-4 shadow-md"
                      >
                        <AskUserQuestionRenderer
                          questions={qs}
                          toolUseId={toolUseId}
                          onAnswers={sendAnswers}
                          onDismiss={(id) => sendAnswers(id, {})}
                        />
                      </div>
                    ) : null,
                  )}
                </div>
              </ErrorBoundary>
            )}
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
