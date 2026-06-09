import { useAutoAnimate } from "@formkit/auto-animate/react";
import { type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type AutoAnimateContainerProps<T extends ElementType = "div"> = {
  as?: T;
  children: ReactNode;
  className?: string;
  duration?: number;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "children" | "className">;

export default function AutoAnimateContainer<T extends ElementType = "div">({
  as,
  children,
  className,
  duration = 180,
  ...props
}: AutoAnimateContainerProps<T>) {
  const [parent] = useAutoAnimate({
    duration,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
  const Component = (as || "div") as ElementType;

  return (
    <Component ref={parent} className={cn(className)} {...props}>
      {children}
    </Component>
  );
}
