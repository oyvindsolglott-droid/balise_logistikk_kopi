"use strict";

const assert = require("node:assert/strict");
const {extractMultipartFile} = require("../src/togplasseringScannerRoutes");

function multipart(filename, bytes, extraFields = []) {
  const boundary = "----SdeScannerTestBoundary";
  const chunks = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
    bytes,
    "\r\n"
  ];
  for (const field of extraFields) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  return {
    buffer: Buffer.concat(chunks.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part))),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const parsed = extractMultipartFile(
  multipart("nattplan.jpg", jpeg, [{name: "model", value: "ignored"}]).buffer,
  multipart("nattplan.jpg", jpeg).contentType
);
assert.equal(parsed.filename, "nattplan.jpg");
assert.deepEqual(parsed.bytes, jpeg);

const boundary = "----SdeScannerTestBoundary";
assert.throws(
  () => extractMultipartFile(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nx\r\n--${boundary}--\r\n`),
    `multipart/form-data; boundary=${boundary}`
  ),
  (error) => error && error.code === "scanner_file_missing"
);

console.log("togplasseringScannerTests: 2/2");
