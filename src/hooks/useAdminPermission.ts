import { useEffect, useState } from "react";

export function useAdminPermission(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    const permission = cockpit.permission({ admin: true });
    const update = () => setAllowed(permission.allowed);

    update();
    permission.addEventListener("changed", update);
    return () => {
      permission.removeEventListener("changed", update);
      permission.close();
    };
  }, []);

  return allowed;
}
