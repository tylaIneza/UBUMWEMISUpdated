import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { updateOrganization } from '../src/services/settings.js';
import { createWorld, lease, makeBuilding, pay, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'PVS', 1, 2, 100000);
});

describe('payment verification setting', () => {
  it('needs a second person by default; switched off, a recorded payment is verified at once', async () => {
    const first = await lease(w, b.floors[0]!.rooms[0]!.id);
    const waiting = await pay(w, 'CASHIER', first.contract.id, 50000);
    expect(waiting.verifiedAt).toBeNull();

    await updateOrganization(w.actors.SUPER_ADMIN, { requirePaymentVerification: false });
    // The payment that was waiting is settled by the change…
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: waiting.id } })).verifiedAt).not.toBeNull();
    // …and new payments need no second approval.
    const second = await lease(w, b.floors[0]!.rooms[1]!.id);
    const direct = await pay(w, 'CASHIER', second.contract.id, 40000);
    expect([direct.verifiedAt !== null, direct.verifiedById]).toEqual([true, direct.recordedById]);

    await updateOrganization(w.actors.SUPER_ADMIN, { requirePaymentVerification: true });
    expect((await pay(w, 'CASHIER', second.contract.id, 10000)).verifiedAt).toBeNull();
  });
});
