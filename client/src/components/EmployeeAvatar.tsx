import React from "react";

type EmployeeAvatarProps = {
  name: string;
  avatar?: string | null;
  className?: string;
  imageClassName?: string;
  showStatus?: boolean;
  status?: "active" | "idle" | "working" | "paused";
};

const COLORS = ["#1b6b4a", "#9a4d14", "#7a3b6e", "#2f5d8a", "#4a5a1e", "#8a2f3a", "#3c4a8a"];

function colorFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/**
 * Shows the employee's portrait when one has been uploaded, and otherwise a
 * colored circle with their first initial.
 */
export const EmployeeAvatar: React.FC<EmployeeAvatarProps> = ({
  name,
  avatar,
  className = "h-12 w-12",
  imageClassName = "",
  showStatus = false,
  status,
}) => {
  const [broken, setBroken] = React.useState(false);
  const isOnline = status === "active" || status === "working";
  React.useEffect(() => setBroken(false), [avatar]);
  const showImage = Boolean(avatar) && !broken;

  return (
    <div className={`relative shrink-0 rounded-full ${className}`} style={{ containerType: "size" }}>
      {showImage ? (
        <img
          src={avatar!}
          alt={`${name}`}
          className={`h-full w-full rounded-full object-cover object-center ${imageClassName}`}
          onError={() => setBroken(true)}
        />
      ) : (
        <div
          aria-label={name}
          className="h-full w-full rounded-full flex items-center justify-center text-white font-extrabold"
          style={{ background: colorFor(name), fontSize: "42cqw" }}
        >
          {name.trim().charAt(0).toUpperCase()}
        </div>
      )}
      {showStatus && (
        <span
          aria-label={isOnline ? "Ready" : "Paused"}
          className={`absolute -right-0.5 -bottom-0.5 h-3.5 w-3.5 rounded-full border-2 border-card ${isOnline ? "bg-emerald-500" : "bg-slate-400"}`}
        />
      )}
    </div>
  );
};
