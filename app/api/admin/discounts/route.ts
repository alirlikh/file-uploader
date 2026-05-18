/**
 * GET    /api/admin/discounts           — list all codes
 * POST   /api/admin/discounts           — create code
 * PATCH  /api/admin/discounts?id=X      — update (toggle active, change expiry/maxUses)
 * DELETE /api/admin/discounts?id=X      — delete code
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import {
  getAllDiscountCodes,
  createDiscountCode,
  updateDiscountCode,
  deleteDiscountCode,
} from "@/lib/db";

export async function GET(req: NextRequest) {
  const s = await getSession(req);
  if (!s?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  return NextResponse.json({ discounts: await getAllDiscountCodes() });
}

export async function POST(req: NextRequest) {
  const s = await getSession(req);
  if (!s?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const b = await req.json().catch(() => ({}));
  const {
    code,
    description,
    discountPct,
    maxUses,
    validFrom,
    validUntil,
    appliesTo,
  } = b;

  if (!code || !discountPct)
    return NextResponse.json(
      { error: "code and discountPct are required." },
      { status: 400 },
    );
  if (typeof discountPct !== "number" || discountPct < 1 || discountPct > 100)
    return NextResponse.json(
      { error: "discountPct must be 1–100." },
      { status: 400 },
    );

  await createDiscountCode({
    id: randomUUID(),
    code: String(code).toUpperCase().trim(),
    description: description ?? null,
    discountPct: Math.round(discountPct),
    maxUses: maxUses ? Number(maxUses) : null,
    validFrom: validFrom ? new Date(validFrom) : new Date(),
    validUntil: validUntil ? new Date(validUntil) : null,
    appliesTo: Array.isArray(appliesTo) && appliesTo.length ? appliesTo : null,
    createdBy: s.sub,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const s = await getSession(req);
  if (!s?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  const b = await req.json().catch(() => ({}));
  await updateDiscountCode(id, {
    isActive: b.isActive !== undefined ? !!b.isActive : undefined,
    maxUses:
      b.maxUses !== undefined
        ? b.maxUses
          ? Number(b.maxUses)
          : null
        : undefined,
    validUntil:
      b.validUntil !== undefined
        ? b.validUntil
          ? new Date(b.validUntil)
          : null
        : undefined,
    description:
      b.description !== undefined ? String(b.description) : undefined,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const s = await getSession(req);
  if (!s?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  await deleteDiscountCode(id);
  return NextResponse.json({ ok: true });
}
