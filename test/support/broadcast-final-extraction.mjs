import { publicTimeline } from "./broadcast-availability-observer.mjs";

// One final read per own page. Raw object keys exist only within this call and
// are joined synchronously before any receipt or error can be serialised.
export async function extractFinal(pages, bound = operation => operation()) {
  const results = await Promise.all(pages.map(async ({ name, page, network }) => {
    let value;
    try {
      value = await bound(() => page.evaluate(() => ({
        receipt: window.relaySwarmDemo?.report(),
        appendFailures: window.broadcastAppendFailures,
        mediaDiagnostics: window.relaySwarmMediaDiagnostics,
        privateAvailability: window.relaySwarmAvailabilityPrivate(),
      })));
      return { name, network, value, extracted: true };
    } catch {
      value = null;
      return { name, network, value: null, extracted: false };
    }
  }));
  let availability = null, conversion = false;
  try {
    availability = publicTimeline(results.filter(row => row.extracted).map(row => ({ role: row.name, value: row.value.privateAvailability })));
    conversion = true;
  } catch { /* Never persist the exception or any rejected private input. */ }
  finally {
    for (const row of results) if (row.value) delete row.value.privateAvailability;
  }
  return {
    viewers: results.map(({ name, network, value }) => ({ name, network, receipt: value?.receipt ?? null, appendFailures: value?.appendFailures ?? null, mediaDiagnostics: value?.mediaDiagnostics ?? null })),
    availability,
    extraction: { ok: conversion && results.every(row => row.extracted), conversion, pages: results.map(({ name, extracted }) => ({ name, extracted, failureClass: extracted ? null : "ExtractionUnavailable" })), failureClass: conversion ? null : "TimelineInvalid" },
  };
}
