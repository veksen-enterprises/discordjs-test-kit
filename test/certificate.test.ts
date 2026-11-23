import { X509Certificate } from "node:crypto";
import { expect, it } from "vitest";
import { selfSignedCertificate } from "../src/internal/certificate.js";

it("makes a voice server certificate OpenSSL accepts, every time", () => {
  // Arrange: one in ~200 used to carry a padded serial, which OpenSSL refuses.
  const rejected: string[] = [];
  let parsed = 0;

  // Act
  for (let i = 0; i < 1000; i++) {
    try {
      if (new X509Certificate(selfSignedCertificate().cert).subject) parsed++;
    } catch (error) {
      rejected.push((error as Error).message);
    }
  }

  // Assert
  expect([parsed, rejected]).toEqual([1000, []]);
});
