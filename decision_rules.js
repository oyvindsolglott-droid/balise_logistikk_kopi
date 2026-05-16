const TRACKS = {

  "9": {
    type: "oppstilling",
    doubleSet: true
  },

  "10": {
    type: "pendel",
    doubleSet: true,
    preferredFor: ["Porsgrunn-Notodden"]
  },

  "11": {
    type: "oppstilling",
    doubleSet: true
  },

  "12": {
    type: "oppstilling",
    doubleSet: true
  },

  "10S": {
    type: "oppstilling",
    blockRisk: "high"
  },

  "11S": {
    type: "oppstilling",
    blockRisk: "high"
  },

  "12S": {
    type: "oppstilling",
    blockRisk: "high"
  },

  "6N": {
    type: "service",
    water: true,
    sewage: true
  },

  "6S": {
    type: "service",
    water: true,
    sewage: true
  },

  "7N": {
    type: "workshop"
  },

  "7S": {
    type: "workshop"
  },

  "8N": {
    type: "workshop"
  },

  "8S": {
    type: "workshop"
  },

  "4S": {
    type: "south_access"
  },

  "5S": {
    type: "south_access"
  },

  "6SS": {
    type: "south_access"
  },

  "7SS": {
    type: "south_access"
  },

  "8SS": {
    type: "south_access"
  },

  "5SS": {
    type: "strategic",
    blocksSouthFlow: true
  }

};
function evaluateMove(move) {
  let score = 0;
  const reasons = [];

  const track = TRACKS[move.toSlot];

  if (!track) {
    score -= 999;
    reasons.push("ukjent spor");
  }

  if (move.mustUseSouthEnd && move.toSlot === "5SS") {
    score -= 350;
    reasons.push("5SS blokkerer sørgående skiftevei");
  }

  if (move.needsWorkshop && track && track.type === "workshop") {
    score += 250;
    reasons.push("defekt kjøretøy plasseres i verkstedspor");
  }

  if (!move.needsWorkshop && track && track.type === "workshop") {
    score -= 250;
    reasons.push("operativt kjøretøy bør ikke oppta verkstedspor");
  }

  if (move.needsService && track && track.type === "service") {
    score += 180;
    reasons.push("kjøretøy med servicebehov plasseres i servicespor");
  }

  if (!move.needsService && track && track.type === "service") {
    score -= 220;
    reasons.push("servicespor blokkeres av kjøretøy uten servicebehov");
  }

  if (move.isDoubleSet && track && track.doubleSet) {
    score += 140;
    reasons.push("dobbeltsett plasseres i spor med plass til dobbeltsett");
  }

  if (
    move.route === "Porsgrunn-Notodden" &&
    move.toSlot === "10"
  ) {
    score += 180;
    reasons.push("spor 10 prioriteres for Porsgrunn-Notodden");
  }

  if (
    move.isActive &&
    ["10S", "11S", "12S"].includes(move.toSlot)
  ) {
    score -= 150;
    reasons.push("aktivt kjøretøy risikerer innestenging i 10S/11S/12S");
  }

  if (
    move.needsWashNorth &&
    ["4S", "5S", "6SS", "7SS", "8SS"].includes(move.toSlot) &&
    !move.coupledMoveTogether
  ) {
    score -= 180;
    reasons.push("dårlig plassering for kjøretøy som skal til vask i nordenden");
  }

  return {
    move,
    score,
    reasons
  };
}

const TEST_MOVES = [

  {
    vehicle: "74-20",
    fromSlot: "4S",
    toSlot: "5SS",
    mustUseSouthEnd: true,
    needsWorkshop: false,
    needsService: false
  },

  {
    vehicle: "74-21",
    fromSlot: "5S",
    toSlot: "7N",
    mustUseSouthEnd: false,
    needsWorkshop: true,
    needsService: false
  },

  {
    vehicle: "74-22",
    fromSlot: "9",
    toSlot: "6N",
    mustUseSouthEnd: false,
    needsWorkshop: false,
    needsService: true
  },

  {
    vehicle: "74-23+74-24",
    fromSlot: "5S",
    toSlot: "10",
    mustUseSouthEnd: false,
    needsWorkshop: false,
    needsService: false,
    isDoubleSet: true
  },

  {
    vehicle: "74-25+74-26",
    fromSlot: "11",
    toSlot: "10",
    mustUseSouthEnd: false,
    needsWorkshop: false,
    needsService: false,
    isDoubleSet: true,
    route: "Porsgrunn-Notodden"
  },

  {
    vehicle: "74-27",
    fromSlot: "4S",
    toSlot: "10S",
    mustUseSouthEnd: false,
    needsWorkshop: false,
    needsService: false,
    isActive: true
  },

  {
    vehicle: "74-28",
    fromSlot: "9",
    toSlot: "5S",
    mustUseSouthEnd: false,
    needsWorkshop: false,
    needsService: false,
    needsWashNorth: true,
    coupledMoveTogether: false
  },

  {
    vehicle: "74-29+74-30",
    fromSlot: "11",
    toSlot: "5S",
    mustUseSouthEnd: false,
    needsWorkshop: false,
    needsService: false,
    needsWashNorth: true,
    coupledMoveTogether: true,
    isDoubleSet: true
  }

];

for (const move of TEST_MOVES) {
  console.log(evaluateMove(move));
}
