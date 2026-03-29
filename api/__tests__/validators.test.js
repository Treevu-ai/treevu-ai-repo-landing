// Tests para api/lib/validators.js — funciones puras, sin dependencias externas
import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { isValidEmail, detectGender, extractEmail } from '../lib/validators.js';

// ── isValidEmail ──────────────────────────────────────────────────────────────
test('isValidEmail: acepta emails válidos', () => {
  assert.ok(isValidEmail('usuario@empresa.com'));
  assert.ok(isValidEmail('nombre.apellido+tag@sub.dominio.com.pe'));
  assert.ok(isValidEmail('user@gettreevu.com'));
});

test('isValidEmail: rechaza emails inválidos', () => {
  assert.equal(isValidEmail('no-es-email'),       false);
  assert.equal(isValidEmail('@sinusuario.com'),    false);
  assert.equal(isValidEmail('sin-arroba.com'),     false);
  assert.equal(isValidEmail(''),                   false);
  assert.equal(isValidEmail(null),                 false);
  assert.equal(isValidEmail('a@b.c'),              false); // TLD muy corto
});

// ── detectGender ──────────────────────────────────────────────────────────────
test('detectGender: detecta femenino por terminación en "a"', () => {
  assert.equal(detectGender('Maria García'),    'F');
  assert.equal(detectGender('Carolina López'),  'F');
  assert.equal(detectGender('Rosa Méndez'),     'F');
});

test('detectGender: detecta masculino por defecto', () => {
  assert.equal(detectGender('Ricardo Cuba'),    'M');
  assert.equal(detectGender('Carlos Pérez'),    'M');
  assert.equal(detectGender(null),              'M');
});

test('detectGender: excepciones masculinas correctas (nombres en "a" que son hombres)', () => {
  assert.equal(detectGender('Nikola Tesla'),    'M');
  assert.equal(detectGender('Luca Toni'),       'M');
  assert.equal(detectGender('Joshua Lima'),     'M');
});

test('detectGender: casos especiales femeninos', () => {
  assert.equal(detectGender('Carmen Ruiz'),     'F');
  assert.equal(detectGender('Pilar Vargas'),    'F');
  assert.equal(detectGender('Mercedes López'),  'F');
});

// ── extractEmail ──────────────────────────────────────────────────────────────
test('extractEmail: extrae email de texto libre', () => {
  assert.equal(extractEmail('Mi correo es hola@empresa.com ok'), 'hola@empresa.com');
  assert.equal(extractEmail('Sin email aquí'),                    null);
  assert.equal(extractEmail(null),                                null);
});
