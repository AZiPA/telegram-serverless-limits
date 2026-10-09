import { db } from 'sdk';
import { collectDiagnostics } from '../lib/diagnostics.js';

export default async function () {
  return collectDiagnostics(db);
}
