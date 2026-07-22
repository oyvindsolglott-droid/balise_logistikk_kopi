"use strict";

const VEHICLE_REGISTRY = deepFreeze({
  "69": [
    "69-38", "69-39", "69-40", "69-42", "69-45", "69-46", "69-47", "69-49",
    "69-55", "69-58", "69-61", "69-63", "69-64", "69-67", "69-69", "69-72",
    "69-73", "69-74", "69-75", "69-76", "69-77", "69-78", "69-79", "69-80",
    "69-81", "69-82", "69-83", "69-84", "69-85", "69-86", "69-87", "69-88"
  ],
  "70": [
    "70-02", "70-04", "70-05", "70-06", "70-10", "70-11", "70-12", "70-14"
  ],
  "74": [
    "74-01", "74-02", "74-03", "74-04", "74-06", "74-07", "74-08", "74-09",
    "74-10", "74-11", "74-12", "74-13", "74-14", "74-15", "74-16", "74-17",
    "74-18", "74-19", "74-20", "74-21", "74-22", "74-23", "74-24", "74-25",
    "74-26", "74-27", "74-28", "74-29", "74-30", "74-31", "74-32", "74-33",
    "74-34", "74-35", "74-36", "74-37", "74-38", "74-39", "74-40", "74-41",
    "74-42", "74-43", "74-44", "74-45", "74-46", "74-47", "74-48", "74-49",
    "74-50", "74-51", "74-52", "74-53", "74-54"
  ],
  "75": [
    "75-01", "75-02", "75-03", "75-04", "75-05", "75-06", "75-07", "75-08",
    "75-09", "75-10", "75-11", "75-12", "75-13", "75-14", "75-15", "75-16",
    "75-17", "75-18", "75-19", "75-20", "75-21", "75-22", "75-23", "75-24",
    "75-25", "75-26", "75-27", "75-28", "75-29", "75-30", "75-31", "75-32",
    "75-33", "75-34", "75-35", "75-36", "75-37", "75-38", "75-39", "75-40",
    "75-41", "75-42", "75-43", "75-44", "75-45", "75-46", "75-47", "75-48",
    "75-49", "75-50", "75-51", "75-52", "75-53", "75-54", "75-55", "75-56",
    "75-57", "75-58", "75-59", "75-60", "75-61", "75-62", "75-63", "75-64",
    "75-65", "75-66", "75-67", "75-68", "75-69", "75-70", "75-71", "75-72",
    "75-73", "75-74", "75-75", "75-76", "75-77", "75-78", "75-79", "75-80",
    "75-81", "75-82", "75-83"
  ]
});

const REGISTERED_VEHICLES = new Set(Object.values(VEHICLE_REGISTRY).flat());
const VEHICLE_REGISTRY_SIZE = REGISTERED_VEHICLES.size;

if(VEHICLE_REGISTRY_SIZE !== 176){
  throw new Error("The authoritative DROPS vehicle registry must contain exactly 176 vehicles.");
}

function normalizeRegisteredVehicleId(value){
  if(typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if(!/^\d{2}-\d{2}$/.test(normalized)) return null;
  return normalized;
}

function isRegisteredVehicle(value){
  const normalized = normalizeRegisteredVehicleId(value);
  return Boolean(normalized && REGISTERED_VEHICLES.has(normalized));
}

function deepFreeze(value){
  if(!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for(const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

module.exports = {
  VEHICLE_REGISTRY,
  VEHICLE_REGISTRY_SIZE,
  isRegisteredVehicle,
  normalizeRegisteredVehicleId
};
