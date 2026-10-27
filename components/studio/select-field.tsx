import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function SelectField({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: string | number;
  options: (string | { value: string; label: string })[];
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <label className="form-field">
      <span>
        {label}
        {children}
      </span>
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option
              key={typeof o === "string" ? o : o.value}
              value={typeof o === "string" ? o : o.value}
            >
              {typeof o === "string" ? o : o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} />
      </div>
    </label>
  );
}
