const base = process.argv[2];
const health = await (await fetch(base + "/api/health")).json();
console.log("health:", health.dataSources.map((x) => x.name + ":" + x.status).join(" "));
const trip = await (await fetch(base + "/api/trips/trip-20261115-3bb123")).json();
console.log("files:", trip.files.map((f) => f.name).join(", "));
console.log("plan days:", trip.plan?.days?.length, "total:", trip.plan?.budget?.total, "delta:", trip.plan?.budget?.delta);
const md = await fetch(base + "/api/trips/trip-20261115-3bb123/files/itinerary.md");
console.log("itinerary.md HTTP", md.status, (await md.text()).slice(0, 120).replace(/\n/g, " | "));
