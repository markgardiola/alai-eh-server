// burst-test.js  --  node burst-test.js
const BASE = "http://localhost:5000/api";

const requests = Array.from({ length: 10 }, (_, i) =>
  fetch(`${BASE}/register/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `panelist${i}`,
      email: `panelist${i}@example.com`,
      phone: `0917000${String(1000 + i)}`,
      password: "Test1234!",
    }),
  }).then(async (r) => ({ i, status: r.status, body: await r.json() })),
);

Promise.all(requests).then((results) =>
  results.forEach((r) => console.log(r.i, r.status, r.body.message)),
);
