export type SeverityColor = "red" | "orange" | "yellow" | "blue" | "grey";

export function severityColor(severity: string): SeverityColor {
  switch (severity) {
    case "Critical":
      return "red";
    case "High":
      return "orange";
    case "Medium":
      return "yellow";
    case "Low":
      return "blue";
    default:
      return "grey";
  }
}
