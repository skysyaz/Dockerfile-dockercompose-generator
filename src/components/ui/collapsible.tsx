import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "@/lib/utils";

const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

function CollapsibleContentStyled({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn("overflow-hidden data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down", className)}
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContentStyled as CollapsibleContent,
};
