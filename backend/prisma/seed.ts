import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ---------------------------------------------------------------------------
  // Property — Park Meadows Apartments (matches entreviewer seed_and_testing.md)
  // ---------------------------------------------------------------------------
  const property = await prisma.property.upsert({
    where: { name: 'Park Meadows Apartments' },
    update: {},
    create: {
      name: 'Park Meadows Apartments',
      address: '123 Main St',
      city: 'Denver',
      state: 'CO',
      zipCode: '80206',
      status: 'active',
    },
  });
  console.log(`Property: ${property.name} (${property.id})`);

  // ---------------------------------------------------------------------------
  // Unit type
  // ---------------------------------------------------------------------------
  const unitType = await prisma.unitType.upsert({
    where: { propertyId_name: { propertyId: property.id, name: '1BR/1BA' } },
    update: {},
    create: {
      propertyId: property.id,
      name: '1BR/1BA',
      bedrooms: 1,
      bathrooms: 1.0,
      squareFootage: 700,
    },
  });

  // ---------------------------------------------------------------------------
  // 20 units (101–120)
  // ---------------------------------------------------------------------------
  const units: Record<string, { id: string }> = {};
  for (let n = 1; n <= 20; n++) {
    const unitNumber = (100 + n).toString();
    const floor = Math.floor((n - 1) / 10) + 1;
    const unit = await prisma.unit.upsert({
      where: { propertyId_unitNumber: { propertyId: property.id, unitNumber } },
      update: {},
      create: { propertyId: property.id, unitTypeId: unitType.id, unitNumber, floor, status: 'occupied' },
    });
    units[unitNumber] = unit;
  }

  // ---------------------------------------------------------------------------
  // Unit pricing — all units at $1600 base & market (except scenario overrides)
  // ---------------------------------------------------------------------------
  const pricingDate = new Date();
  pricingDate.setHours(0, 0, 0, 0);

  for (const [unitNumber, unit] of Object.entries(units)) {
    // Jane Doe unit 101: $1400 rent vs $1600 market (above market signal)
    const baseRent = unitNumber === '101' ? 1400 : unitNumber === '102' ? 1500 : unitNumber === '103' ? 1600 : unitNumber === '104' ? 1450 : 1600;
    const marketRent = 1600;
    await prisma.unitPricing.upsert({
      where: { unitId_effectiveDate: { unitId: unit.id, effectiveDate: pricingDate } },
      update: {},
      create: { unitId: unit.id, baseRent, marketRent, effectiveDate: pricingDate },
    });
  }

  // ---------------------------------------------------------------------------
  // Scenario 1: Jane Doe — HIGH risk
  // 45 days to expiry, no renewal offer, paying on time, rent below market
  // ---------------------------------------------------------------------------
  const janeDoe = await prisma.resident.upsert({
    where: { id: '00000000-0000-0000-0000-000000000101' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000101',
      propertyId: property.id,
      unitId: units['101'].id,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      phone: '303-555-0101',
      status: 'active',
      moveInDate: new Date('2023-01-15'),
    },
  });

  const janeDoeLeaseEnd = new Date(today);
  janeDoeLeaseEnd.setDate(janeDoeLeaseEnd.getDate() + 45);

  const janeLease = await prisma.lease.upsert({
    where: { id: '10000000-0000-0000-0000-000000000101' },
    update: {},
    create: {
      id: '10000000-0000-0000-0000-000000000101',
      propertyId: property.id,
      residentId: janeDoe.id,
      unitId: units['101'].id,
      leaseStartDate: new Date('2023-01-15'),
      leaseEndDate: janeDoeLeaseEnd,
      monthlyRent: 1400,
      leaseType: 'fixed',
      status: 'active',
    },
  });

  // Jane: 6 payments on time
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    d.setDate(1);
    await prisma.residentLedger.createMany({
      data: [
        { propertyId: property.id, residentId: janeDoe.id, leaseId: janeLease.id, transactionType: 'charge', chargeCode: 'rent', amount: 1400, transactionDate: d },
        { propertyId: property.id, residentId: janeDoe.id, leaseId: janeLease.id, transactionType: 'payment', chargeCode: 'rent', amount: 1400, transactionDate: new Date(d.getTime() + 2 * 86400000) },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: John Smith — MEDIUM risk
  // 60 days to expiry, 1 missed payment
  // ---------------------------------------------------------------------------
  const johnSmith = await prisma.resident.upsert({
    where: { id: '00000000-0000-0000-0000-000000000102' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000102',
      propertyId: property.id,
      unitId: units['102'].id,
      firstName: 'John',
      lastName: 'Smith',
      email: 'john.smith@example.com',
      phone: '303-555-0102',
      status: 'active',
      moveInDate: new Date('2023-01-15'),
    },
  });

  const johnLeaseEnd = new Date(today);
  johnLeaseEnd.setDate(johnLeaseEnd.getDate() + 60);

  const johnLease = await prisma.lease.upsert({
    where: { id: '10000000-0000-0000-0000-000000000102' },
    update: {},
    create: {
      id: '10000000-0000-0000-0000-000000000102',
      propertyId: property.id,
      residentId: johnSmith.id,
      unitId: units['102'].id,
      leaseStartDate: new Date('2023-01-15'),
      leaseEndDate: johnLeaseEnd,
      monthlyRent: 1500,
      leaseType: 'fixed',
      status: 'active',
    },
  });

  // John: 5 of 6 payments (1 missed — skip i=2)
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    d.setDate(1);
    await prisma.residentLedger.create({
      data: { propertyId: property.id, residentId: johnSmith.id, leaseId: johnLease.id, transactionType: 'charge', chargeCode: 'rent', amount: 1500, transactionDate: d },
    });
    if (i !== 2) {
      await prisma.residentLedger.create({
        data: { propertyId: property.id, residentId: johnSmith.id, leaseId: johnLease.id, transactionType: 'payment', chargeCode: 'rent', amount: 1500, transactionDate: new Date(d.getTime() + 2 * 86400000) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Scenario 3: Alice Johnson — LOW risk
  // 180 days to expiry, renewal offer sent, all payments on time
  // ---------------------------------------------------------------------------
  const aliceJohnson = await prisma.resident.upsert({
    where: { id: '00000000-0000-0000-0000-000000000103' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000103',
      propertyId: property.id,
      unitId: units['103'].id,
      firstName: 'Alice',
      lastName: 'Johnson',
      email: 'alice.johnson@example.com',
      phone: '303-555-0103',
      status: 'active',
      moveInDate: new Date('2023-06-15'),
    },
  });

  const aliceLeaseEnd = new Date(today);
  aliceLeaseEnd.setDate(aliceLeaseEnd.getDate() + 180);

  const aliceLease = await prisma.lease.upsert({
    where: { id: '10000000-0000-0000-0000-000000000103' },
    update: {},
    create: {
      id: '10000000-0000-0000-0000-000000000103',
      propertyId: property.id,
      residentId: aliceJohnson.id,
      unitId: units['103'].id,
      leaseStartDate: new Date('2023-06-15'),
      leaseEndDate: aliceLeaseEnd,
      monthlyRent: 1600,
      leaseType: 'fixed',
      status: 'active',
    },
  });

  for (let i = 5; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    d.setDate(1);
    await prisma.residentLedger.createMany({
      data: [
        { propertyId: property.id, residentId: aliceJohnson.id, leaseId: aliceLease.id, transactionType: 'charge', chargeCode: 'rent', amount: 1600, transactionDate: d },
        { propertyId: property.id, residentId: aliceJohnson.id, leaseId: aliceLease.id, transactionType: 'payment', chargeCode: 'rent', amount: 1600, transactionDate: new Date(d.getTime() + 2 * 86400000) },
      ],
    });
  }

  await prisma.renewalOffer.create({
    data: {
      propertyId: property.id,
      residentId: aliceJohnson.id,
      leaseId: aliceLease.id,
      renewalStartDate: aliceLeaseEnd,
      renewalEndDate: new Date(aliceLeaseEnd.getTime() + 365 * 86400000),
      proposedRent: 1650,
      offerExpirationDate: new Date(today.getTime() + 60 * 86400000),
      status: 'pending',
    },
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Bob Williams — HIGH risk (month-to-month, expired lease)
  // Lease already past end date, all payments on time
  // ---------------------------------------------------------------------------
  const bobWilliams = await prisma.resident.upsert({
    where: { id: '00000000-0000-0000-0000-000000000104' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000104',
      propertyId: property.id,
      unitId: units['104'].id,
      firstName: 'Bob',
      lastName: 'Williams',
      email: 'bob.williams@example.com',
      phone: '303-555-0104',
      status: 'active',
      moveInDate: new Date('2024-12-01'),
    },
  });

  const bobLease = await prisma.lease.upsert({
    where: { id: '10000000-0000-0000-0000-000000000104' },
    update: {},
    create: {
      id: '10000000-0000-0000-0000-000000000104',
      propertyId: property.id,
      residentId: bobWilliams.id,
      unitId: units['104'].id,
      leaseStartDate: new Date('2024-12-01'),
      leaseEndDate: new Date('2025-01-01'), // already expired → month-to-month
      monthlyRent: 1450,
      leaseType: 'month_to_month',
      status: 'active',
    },
  });

  for (let i = 5; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    d.setDate(1);
    await prisma.residentLedger.createMany({
      data: [
        { propertyId: property.id, residentId: bobWilliams.id, leaseId: bobLease.id, transactionType: 'charge', chargeCode: 'rent', amount: 1450, transactionDate: d },
        { propertyId: property.id, residentId: bobWilliams.id, leaseId: bobLease.id, transactionType: 'payment', chargeCode: 'rent', amount: 1450, transactionDate: new Date(d.getTime() + 2 * 86400000) },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n=== Seed complete ===');
  console.log(`Property: ${property.name} (${property.id})`);
  console.log('\nExpected risk scores:');
  console.log('  Jane Doe      — HIGH   (~85): 45d to expiry, on-time payments, no offer, rent below market ($1400 vs $1600)');
  console.log('  John Smith    — MEDIUM (~70): 60d to expiry, 1 missed payment, no offer');
  console.log('  Alice Johnson — LOW    (~20): 180d to expiry, on-time payments, renewal offer sent');
  console.log('  Bob Williams  — HIGH   (~65): MTM lease (already expired), on-time payments, no offer');
  console.log(`\nUse property ID ${property.id} in API calls.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
