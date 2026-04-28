import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getUserById,
  setUserBlocked,
  setUserPlan,
  setUserAdmin,
  PLANS,
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

  const body = await req.json();
  const { action } = body;

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
    const plan = body.plan as Plan;
    if (!Object.keys(PLANS).includes(plan))
      return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    const customBytes =
      plan === "custom" ? Number(body.customLimitBytes) || null : null;
    await setUserPlan(id, plan, customBytes);
  } else if (action === "setAdmin") {
    if (id === session.sub)
      return NextResponse.json(
        { error: "Cannot change your own admin status." },
        { status: 400 },
      );
    await setUserAdmin(id, !!body.isAdmin);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const updated = await getUserById(id);
  if (!updated)
    return NextResponse.json(
      { error: "User not found after update." },
      { status: 500 },
    );

  return NextResponse.json({
    user: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      isAdmin: updated.is_admin,
      isBlocked: updated.is_blocked,
      plan: updated.plan,
      customLimitBytes: updated.custom_limit_bytes,
    },
  });
}
