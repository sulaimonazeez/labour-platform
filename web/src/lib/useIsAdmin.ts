import { useEffect, useState } from "react";
import { api } from "./api";

/** The server decides who is staff (PLATFORM_ADMIN_USER_IDS). We only ask whether the admin door opens, to decide whether to show the link. */
export function useIsAdmin(userId: string | undefined): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api("GET", "/admin/attention").then(() => { if (alive) setIsAdmin(true); }).catch(() => { if (alive) setIsAdmin(false); });
    return () => { alive = false; };
  }, [userId]);
  return isAdmin;
}
