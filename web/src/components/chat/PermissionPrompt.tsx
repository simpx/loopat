import { useLoopRuntimeExtra } from "@/useLoopRuntime";

export default function PermissionPrompt() {
  const { permissionPrompt, answerPermission } = useLoopRuntimeExtra();

  if (!permissionPrompt) return null;

  return (
    <div className="border-t border-gray-200 bg-amber-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-900">
            {permissionPrompt.title}
          </p>
          <p className="mt-0.5 text-xs text-amber-700">
            {permissionPrompt.displayName}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => answerPermission(permissionPrompt.toolUseId, true)}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => answerPermission(permissionPrompt.toolUseId, false)}
            className="rounded-lg bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-200 transition-colors"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
