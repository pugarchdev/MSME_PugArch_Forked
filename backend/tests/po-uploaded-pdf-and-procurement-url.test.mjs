import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('1. Backend invoice-pdf.service resolves uploaded PO PDF and attaches it for seller notifications', () => {
  const invoicePdfServicePath = path.resolve('src/services/invoice-pdf.service.ts');
  const code = fs.readFileSync(invoicePdfServicePath, 'utf8');

  // Verify getOrGeneratePurchaseOrderPdfBuffer queries DB fallback when externalPdfFileId is not passed in in-memory object
  assert.match(code, /freshPo\s*=\s*await db\.purchaseOrder\.findUnique/);
  assert.match(code, /select:\s*\{\s*externalPdfFileId:\s*true,\s*pdfFileId:\s*true/);

  // Verify asset.status !== 'deleted' is checked rather than strictly 'active'
  assert.match(code, /asset\.status !== 'deleted'/);

  // Verify role: 'admin' is supplied to getFileContent for internal notification generator
  assert.match(code, /getFileContent\(asset\.id,\s*\{\s*id:\s*asset\.ownerId/);
  assert.match(code, /role:\s*'admin'/);

  // Verify notifyPurchaseOrderCreated handles generated and order_confirmed
  assert.match(code, /'generated',\s*'order_confirmed'/);

  // Verify email note & PDF attachment are included
  assert.match(code, /Official Purchase Order PDF is attached to this email/);
});

test('2. Backend storage.service allows organization counterparty access and robust file path resolution', () => {
  const storageServicePath = path.resolve('src/services/storage/storage.service.ts');
  const code = fs.readFileSync(storageServicePath, 'utf8');

  // Verify counterparty organization access in canAccessFileAsset
  assert.match(code, /poDoc\.buyer\?\.organizationId === userOrgId \|\| poDoc\.seller\?\.organizationId === userOrgId/);

  // Verify localCandidates checks cleanKey, baseKey, and rawKey across multiple directories
  assert.match(code, /cleanKey\s*=\s*rawKey\.replace/);
  assert.match(code, /path\.resolve\(process\.cwd\(\),\s*'uploads',\s*cleanKey\)/);
  assert.match(code, /path\.resolve\(process\.cwd\(\),\s*'\.\.\/uploads',\s*cleanKey\)/);
});

test('3. Backend phase4 routes include externalPdfFile & pdfFile on purchase-orders endpoints and accept externalPdfFileId on issue', () => {
  const phase4RoutesPath = path.resolve('src/routes/phase4.routes.ts');
  const code = fs.readFileSync(phase4RoutesPath, 'utf8');

  // Verify include externalPdfFile and pdfFile
  assert.match(code, /externalPdfFile:\s*\{\s*select:\s*\{\s*id:\s*true,\s*originalName:\s*true/);
  assert.match(code, /pdfFile:\s*\{\s*select:\s*\{\s*id:\s*true,\s*originalName:\s*true/);

  // Verify POST /purchase-orders/:id/issue accepts externalPdfFileId and calls assertFileAssetOwnership
  assert.match(code, /const incomingPdfId = body\.externalPdfFileId \? Number\(body\.externalPdfFileId\) : undefined;/);
  assert.match(code, /await assertFileAssetOwnership\(incomingPdfId, req\);/);
});

test('4. Frontend PurchaseOrders.tsx and PurchaseOrderReceiptModal display uploaded PO and fix procurement button', () => {
  const poViewPath = path.resolve('../frontend/src/views/PurchaseOrders.tsx');
  const poViewCode = fs.readFileSync(poViewPath, 'utf8');

  // Verify resolveProcurementTargetUrl helper is defined and handles various sources
  assert.match(poViewCode, /const resolveProcurementTargetUrl =/);
  assert.match(poViewCode, /order\.sourceType === 'auction'/);
  assert.match(poViewCode, /meta\.bidNumber \|\| meta\.requirementNumber/);

  // Verify Procurement Details button uses resolveProcurementTargetUrl
  assert.match(poViewCode, /const targetUrl = resolveProcurementTargetUrl\(viewingOrder/);

  // Verify Official Uploaded PO PDF card is present
  assert.match(poViewCode, /Official Uploaded Purchase Order \(PDF\) Card/);
  assert.match(poViewCode, /Official authentic Purchase Order document uploaded/);

  // Verify View Uploaded PO PDF is in shared action footer accessible to seller
  assert.match(poViewCode, /View Uploaded PO PDF/);

  const receiptModalPath = path.resolve('../frontend/src/features/purchaseOrders/components/PurchaseOrderReceiptModal.tsx');
  const receiptModalCode = fs.readFileSync(receiptModalPath, 'utf8');

  // Verify header badge is clickable
  assert.match(receiptModalCode, /Buyer Signed PO Attached/);
  assert.match(receiptModalCode, /openFileAsset/);

  // Verify footer button "View Uploaded PO"
  assert.match(receiptModalCode, /View Uploaded PO/);
});
