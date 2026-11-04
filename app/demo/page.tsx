import { redirect } from "next/navigation";
import DemoTransfer from "@/components/demo-transfer";
import { IS_DEMO_PACKAGE } from "@/lib/demo-mode";

export default function DemoPage() {
  if (IS_DEMO_PACKAGE) redirect("/");
  return <DemoTransfer />;
}
