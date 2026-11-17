// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameSimilarity, normalizeName } from '../pipeline/lib/util.mjs';
import { parseCompany, parseUnit, parseShare } from '../pipeline/lib/erst.mjs';
import { parseOverpass } from '../pipeline/fetch-osm.mjs';
import { assemble } from '../pipeline/build.mjs';
import fixtures from './fixtures/sample.json' with { type: 'json' };

test('normalizeName strips legal suffixes and Danish letters', () => {
  assert.equal(normalizeName('Café Bøgen ApS'), 'cafe boegen');
  assert.equal(normalizeName('Hans & Grete A/S'), 'hans og grete');
});

test('nameSimilarity ignores filler words', () => {
  assert.ok(nameSimilarity('Restaurant Mefisto', 'Mefisto Aarhus ApS') >= 0.85);
  assert.ok(nameSimilarity('Pizzeria Roma', 'Sushi Kaito') < 0.3);
});

test('parseShare handles fractions and percents', () => {
  assert.equal(parseShare('0.5'), 0.5);
  assert.ok(Math.abs(parseShare('66,67') - 0.6667) < 1e-9);
  assert.equal(parseShare(undefined), null);
});

test('parseOverpass keeps named places with coordinates', () => {
  const places = parseOverpass(fixtures.overpass);
  assert.equal(places.length, 2);
  assert.equal(places[1].lat, 56.1531);
  assert.equal(places[0].brand, null);
});

test('parseUnit and parseCompany read ERST documents', () => {
  const unit = parseUnit(fixtures.erstUnit);
  assert.equal(unit.cvr, '11111111');
  assert.equal(unit.houseNumber, '12B');
  assert.equal(unit.kommune, 751);
  assert.ok(unit.active);
  const company = parseCompany(fixtures.erstCompany);
  assert.equal(company.owners.length, 1, 'former owner and beneficial owner are excluded');
  assert.equal(company.owners[0].cvr, '99999999');
  assert.equal(company.owners[0].share, 1);
  assert.equal(company.managers[0].name, 'Anna Direktør');
  assert.equal(company.activeUnits, 2);
});

test('assemble matches by address and groups through holding companies', () => {
  const { restaurants, groups } = assemble(fixtures.osm, fixtures.cvr);
  const byName = Object.fromEntries(restaurants.map((r) => [r.name, r]));
  // Matched on same street + number despite different spelling of the name.
  assert.equal(byName['Café Solsikke'].cvr, '10000001');
  // Two operating companies owned by the same holding -> one group of 3 (incl. CVR-only unit).
  assert.equal(byName['Café Solsikke'].groupId, byName['Bistro Mågen'].groupId);
  assert.equal(byName['Café Solsikke'].groupSize, 3);
  assert.equal(byName['Café Solsikke'].category, 'small-group');
  assert.equal(groups[0].label, 'Peter Hansen +1');
  // Owner path walks from operating company to the ultimate personal owner.
  const path = byName['Bistro Mågen'].ownerPaths[0].map((n) => n.name);
  assert.deepEqual(path, ['Mågen ApS', 'Gastro Holding ApS', 'Peter Hansen']);
  // A sole owner with one place is independent; 10% minority owner does not merge groups.
  assert.equal(byName['Pizzeria Lille'].category, 'independent');
  assert.notEqual(byName['Pizzeria Lille'].groupId, byName['Café Solsikke'].groupId);
  // Unmatched OSM place has unknown ownership.
  assert.equal(byName['Ukendt Grill'].category, 'unknown');
});

import { splitAddress, normalizeCvrapi, fromCache } from '../pipeline/lib/cvrapi.mjs';

test('cvrapi.dk results become units in Aarhus only', () => {
  assert.deepEqual(splitAddress('Mejlgade 12b, 1. th'), { street: 'Mejlgade', houseNumber: '12B' });
  const local = { vat: 12345678, name: 'Solsikke ApS', address: 'Mejlgade 12', zipcode: '8000', city: 'Aarhus C',
    owners: [{ name: 'Peter Hansen' }], productionunits: [{ pno: 1, name: 'Café Solsikke', address: 'Mejlgade 12', zipcode: '8000' }] };
  const remote = { vat: 87654321, name: 'Solsikke Odense ApS', address: 'Vestergade 1', zipcode: '5000', productionunits: [] };
  const { units, company } = normalizeCvrapi(local);
  assert.equal(units[0].houseNumber, '12');
  assert.equal(company.owners[0].key, 'name:peter hansen');
  const out = fromCache({ a: { result: local }, b: { result: remote }, c: { result: null } });
  assert.equal(out.units.length, 1);
  assert.deepEqual(Object.keys(out.companies), ['12345678']);
});
