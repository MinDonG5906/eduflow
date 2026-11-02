import { useId, type ReactNode } from "react";

/** Shared reading order: title and action, source context, then editable content. */
export function SceneSection({ title, description, action, children, className = "" }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return <section className={`scene-section ${className}`} aria-labelledby={id}>
    <header className="scene-section-heading">
      <h3 id={id}>{title}</h3>
      {action && <div className="scene-section-action">{action}</div>}
    </header>
    {description && <div className="scene-section-description">{description}</div>}
    {children}
  </section>;
}
