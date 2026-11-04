import { redirect } from "next/navigation";

// The Overview is the home screen (DESIGN_SPEC §5.1).
export default function Home(): never {
  redirect("/overview");
}
