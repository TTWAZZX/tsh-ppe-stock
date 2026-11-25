export async function readInventoryPages(makeQuery, key = 'id') {
  const rows = [];
  let lastId;
  for (;;) {
    let query = makeQuery().order(key, { ascending: true }).limit(250);
    if (lastId !== undefined) query = query.gt(key, lastId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return rows;
    const nextId = data.at(-1)[key];
    if (nextId == null || nextId === lastId) throw new Error('Database pagination key did not advance');
    rows.push(...data);
    lastId = nextId;
  }
}
