/* HISTORICAL_FIXTURE_ONLY: never imported by production planner code. */
const TEST_MOVES = [
  {vehicle:"74-20",fromSlot:"4S",toSlot:"5SS",mustUseSouthEnd:true,needsWorkshop:false,needsService:false},
  {vehicle:"74-21",fromSlot:"5S",toSlot:"7N",mustUseSouthEnd:false,needsWorkshop:true,needsService:false},
  {vehicle:"74-22",fromSlot:"9",toSlot:"6N",mustUseSouthEnd:false,needsWorkshop:false,needsService:true},
  {vehicle:"74-23+74-24",fromSlot:"5S",toSlot:"10",mustUseSouthEnd:false,needsWorkshop:false,needsService:false,isDoubleSet:true},
  {vehicle:"74-25+74-26",fromSlot:"11",toSlot:"10",mustUseSouthEnd:false,needsWorkshop:false,needsService:false,isDoubleSet:true,route:"Porsgrunn-Notodden"},
  {vehicle:"74-27",fromSlot:"4S",toSlot:"10S",mustUseSouthEnd:false,needsWorkshop:false,needsService:false,isActive:true},
  {vehicle:"74-28",fromSlot:"9",toSlot:"5S",mustUseSouthEnd:false,needsWorkshop:false,needsService:false,needsWashNorth:true,coupledMoveTogether:false},
  {vehicle:"74-29+74-30",fromSlot:"11",toSlot:"5S",mustUseSouthEnd:false,needsWorkshop:false,needsService:false,needsWashNorth:true,coupledMoveTogether:true,isDoubleSet:true}
];

const COMPARE_TEST_MOVES = [
  {vehicle:"74-31",fromSlot:"4S",toSlot:"5SS",mustUseSouthEnd:true,needsWorkshop:false,needsService:false},
  {vehicle:"74-31",fromSlot:"4S",toSlot:"6N",mustUseSouthEnd:false,needsWorkshop:false,needsService:true},
  {vehicle:"74-31",fromSlot:"4S",toSlot:"10",mustUseSouthEnd:false,needsWorkshop:false,needsService:false}
];
