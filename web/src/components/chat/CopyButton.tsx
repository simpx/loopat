import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  content: string;
  className?: string;
  iconClassName?: string;
}

export default function CopyButton({ content, className, iconClassName }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!content || copied) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={handleCopy}
          className={className}
          title="Copy message"
        >
          {copied ? (
            <CheckIcon className={cn("h-3 w-3 text-emerald-500", iconClassName)} />
          ) : (
            <CopyIcon className={cn("h-3 w-3", iconClassName)} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}
