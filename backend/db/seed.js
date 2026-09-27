const { pool, initDb } = require('./init');

// Run with: npm run seed
// Adds sample motors, spares, and a bit of breakdown history so you can see
// the app (including MTBF/MTTR) working immediately.
// Safe to run only once — it skips seeding if motors already exist.


async function seed() {
  // Make sure PostgreSQL tables exist before seeding.
  await initDb();


  // Check whether motors already exist.
  const countResult = await pool.query(
    'SELECT COUNT(*) AS n FROM motors'
  );

  const motorsCount = Number(countResult.rows[0].n);

  if (motorsCount > 0) {
    console.log(
      'Motors already exist — skipping seed.'
    );

    await pool.end();
    return;
  }


  const now = new Date();

  const daysAgo = (n) =>
    new Date(
      Date.now() - n * 86400000
    );


  // tag, name, department, kW, voltage, rpm, status,
  // locationType, placementDetail, standbyCategory, condition
  const motors = [
    ['RM-01', 'Roller Mill 1 Main Drive', 'Milling', 55, 415, 1450, 'running', 'Mill floor', 'Bay 1', 'new', 'Good'],

    ['RM-02', 'Roller Mill 2 Main Drive', 'Milling', 55, 415, 1450, 'running', 'Mill floor', 'Bay 2', 'new', 'Winding fault suspected'],

    ['SIFT-01', 'Plansifter Drive Motor', 'Sifting', 11, 415, 960, 'running', 'Mill floor', 'Sifter line', 'new', 'Good'],

    ['PUR-01', 'Purifier Motor', 'Sifting', 7.5, 415, 1440, 'running', 'Mill floor', 'Purifier line', 'new', 'Good'],

    ['CLEAN-01', 'Wheat Cleaner Motor', 'Cleaning', 15, 415, 1450, 'running', 'Mill floor', 'Cleaning section', 'new', 'Good'],

    ['CLEAN-02', 'Destoner Motor', 'Cleaning', 7.5, 415, 1440, 'running', 'Mill floor', 'Cleaning section', 'new', 'Good'],

    ['CONV-01', 'Bucket Elevator Motor — Intake', 'Conveying', 22, 415, 1450, 'running', 'Mill floor', 'Intake shaft', 'new', 'Good'],

    ['CONV-02', 'Screw Conveyor Motor', 'Conveying', 5.5, 415, 1440, 'standby', 'Store', 'Rack 3 — ready unit', 'repaired', 'Repaired after burnout — tested, ready to install'],

    ['PACK-01', 'Bagging Scale Motor', 'Packing', 3.7, 415, 1440, 'running', 'Mill floor', 'Packing hall', 'new', 'Good'],

    ['BLOW-01', 'Pneumatic Conveying Blower', 'Milling', 37, 415, 2900, 'running', 'Mill floor', 'Blower room', 'new', 'Slight vibration, monitor'],

    ['SIFT-02', 'Plansifter 2 Drive Motor', 'Sifting', 11, 415, 960, 'standby', 'Internal workshop', 'Bay 1 — spare, tested', 'repaired', 'Rewound after fault — ready to install'],

    ['CONV-03', 'Belt Conveyor Motor — Packing', 'Conveying', 4, 415, 1440, 'standby', 'Container', 'Container 2, shelf B', 'new', 'New, unused — bought as spare'],
  ].map(r => ({
    tag: r[0],
    name: r[1],
    department: r[2],
    hp: r[3],
    voltage: r[4],
    rpm: r[5],
    manual_status: r[6],
    current_location: '',
    location_type: r[7],
    placement_detail: r[8],
    standby_category: r[9],
    condition_notes: r[10],
    created_at: now,
    updated_at: now
  }));


  const spares = [
    ['Deep groove ball bearing 6308 ZZ', 'BRG-6308ZZ', 'Bearing', 3, 6, 8500, 'Store A — Rack 2, Bin 5', 'Kano Bearings Ltd'],

    ['Deep groove ball bearing 6206 ZZ', 'BRG-6206ZZ', 'Bearing', 9, 6, 3200, 'Store A — Rack 2, Bin 2', 'Kano Bearings Ltd'],

    ['V-belt A-Section, 112in', 'BLT-A112', 'Belt', 5, 4, 4200, 'Store A — Rack 4, Bin 1', 'Belting Nigeria'],

    ['V-belt B-Section, 128in', 'BLT-B128', 'Belt', 2, 4, 5600, 'Store A — Rack 4, Bin 2', 'Belting Nigeria'],

    ['Run capacitor 40uF 450V', 'CAP-40-450', 'Electrical', 6, 5, 6500, 'Store B — Cabinet 1, Drawer 3', 'Elektromech'],

    ['Copper winding wire, 1.25mm (per kg)', 'WIND-CU-125', 'Winding', 12, 10, 15500, 'Store B — Rack 1', 'Lagos Wire Co'],

    ['Motor shaft seal 45x65x8', 'SEAL-456508', 'Seal', 4, 5, 2800, 'Store A — Rack 3, Bin 4', 'Kano Bearings Ltd'],

    ['Overload relay 45-63A', 'OLR-4563', 'Electrical', 2, 3, 18500, 'Store B — Cabinet 1, Drawer 1', 'Elektromech'],

    ['Grease, high-temp bearing (400g)', 'GRS-HT-400', 'Other', 16, 10, 2100, 'Store A — Rack 5', 'Total Lubricants'],
  ].map(r => ({
    name: r[0],
    part_number: r[1],
    category: r[2],
    qty: r[3],
    min_qty: r[4],
    unit_cost: r[5],
    location: r[6],
    supplier: r[7],
    compatible_motor_ids: [],
    created_at: now,
    updated_at: now
  }));


  const client = await pool.connect();


  try {
    await client.query('BEGIN');


    // Insert motors
    const motorIds = {};

    for (const m of motors) {
      const result = await client.query(
        `
        INSERT INTO motors
        (
          tag,
          name,
          department,
          hp,
          voltage,
          rpm,
          manual_status,
          current_location,
          location_type,
          placement_detail,
          standby_category,
          condition_notes,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING id
        `,
        [
          m.tag,
          m.name,
          m.department,
          m.hp,
          m.voltage,
          m.rpm,
          m.manual_status,
          m.current_location,
          m.location_type,
          m.placement_detail,
          m.standby_category,
          m.condition_notes,
          m.created_at,
          m.updated_at
        ]
      );

      motorIds[m.tag] = result.rows[0].id;
    }


    // Insert spares
    for (const s of spares) {
      await client.query(
        `
        INSERT INTO spares
        (
          name,
          part_number,
          category,
          qty,
          min_qty,
          unit_cost,
          location,
          supplier,
          compatible_motor_ids,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11
        )
        `,
        [
          s.name,
          s.part_number,
          s.category,
          s.qty,
          s.min_qty,
          s.unit_cost,
          s.location,
          s.supplier,
          JSON.stringify(s.compatible_motor_ids),
          s.created_at,
          s.updated_at
        ]
      );
    }


    // RM-02 gets sample breakdown history
    const rm02Id = motorIds['RM-02'];


    const history = [
      {
        start: 58,
        downtime: 6.5,
        desc: 'Tripped on overload, bearing noise'
      },
      {
        start: 33,
        downtime: 4.0,
        desc: 'Belt slipping, retensioned'
      },
      {
        start: 12,
        downtime: 9.5,
        desc: 'Winding fault, rewound'
      }
    ];


    for (const h of history) {
      const reportedAt = daysAgo(h.start);

      const resolvedAt = new Date(
        reportedAt.getTime() +
        h.downtime * 3600000
      );


      const timeline = [
        {
          at: reportedAt,
          text: 'Breakdown reported by Seed data.'
        },
        {
          at: resolvedAt,
          text:
            `Resolved — motor returned to service. ` +
            `Total downtime ${h.downtime.toFixed(1)} hours.`
        }
      ];


      await client.query(
        `
        INSERT INTO events
        (
          motor_id,
          reported_at,
          reported_by,
          description,
          urgency,
          stage,
          repair_location,
          repair_location_type,
          condition_notes,
          spares_used,
          motor_swaps,
          timeline,
          resolved_at,
          downtime_hours,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16
        )
        `,
        [
          rm02Id,
          reportedAt,
          'Seed data',
          h.desc,
          'medium',
          'resolved',
          'Workshop — Bay 2',
          '',
          'Good — returned from repair',
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify(timeline),
          resolvedAt,
          h.downtime,
          reportedAt,
          resolvedAt
        ]
      );
    }


    await client.query('COMMIT');


    console.log(
      `Seeded ${motors.length} motors, ` +
      `${spares.length} spares, and ` +
      `3 sample breakdown records on RM-02.`
    );

  } catch (err) {
    await client.query('ROLLBACK');

    console.error('Seeding failed:', err);

    throw err;

  } finally {
    client.release();
  }

  await pool.end();
}


seed().catch(() => {
  process.exit(1);
});