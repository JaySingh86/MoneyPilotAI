import type { Metadata } from "next";
import { InviteAccept } from "./InviteAccept";

export const metadata: Metadata = { title: "Join a household", robots: { index: false } };

export default function InvitePage() {
  return <InviteAccept />;
}
