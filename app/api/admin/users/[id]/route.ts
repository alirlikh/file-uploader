import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getUserById,
  setUserBlocked,
  setUserPlan,
  setUserAdmin,
  PLAN_DEFAULTS,
  type Plan,
} from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req);
  if (!session?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const { id } = await params;
  const target = await getUserById(id);
  if (!target)
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  const { action, ...body } = await req.json();

  if (action === "block") {
    if (id === session.sub)
      return NextResponse.json(
        { error: "Cannot block yourself." },
        { status: 400 },
      );
    await setUserBlocked(id, true);
  } else if (action === "unblock") {
    await setUserBlocked(id, false);
  } else if (action === "setPlan") {
    if (!Object.keys(PLAN_DEFAULTS).includes(body.plan))
      return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    await setUserPlan(
      id,
      body.plan as Plan,
      body.plan === "custom" ? Number(body.customLimitBytes) || null : null,
    );
  } else if (action === "setAdmin") {
    if (id === session.sub)
      return NextResponse.json(
        { error: "Cannot change own admin status." },
        { status: 400 },
      );
    await setUserAdmin(id, !!body.isAdmin);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const updated = await getUserById(id);
  return NextResponse.json({
    user: {
      id: updated!.id,
      email: updated!.email,
      name: updated!.name,
      isAdmin: updated!.is_admin,
      isBlocked: updated!.is_blocked,
      plan: updated!.plan,
      customLimitBytes: updated!.custom_limit_bytes,
    },
  });
}
