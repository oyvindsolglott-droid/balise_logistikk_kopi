const {
  PRODUCTION_DB_PATH,
  PRODUCTION_PORT,
  isProductionDatabasePath,
  isTmpDatabasePath
} = require("./serverNoteGuards");

const CONFLICTING_SDE_RECOMMENDATION_ACK_FLAGS = [
  "SDE_ENABLE_SCHEMA_MIGRATIONS",
  "SDE_ENABLE_TEST_WRITES",
  "SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES",
  "SDE_ENABLE_ACTION_CONTRACT_TESTS",
  "SDE_ENABLE_SERVER_NOTE_ACTIONS"
];

function getSdeRecommendationAckGuardFailure(options){
  const env = options.env || process.env;
  if(!isFlagEnabled(env, "SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS")){
    return {
      error: "sde_recommendation_ack_actions_disabled",
      message: "SDE recommendation ack actions are disabled. Set SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS=1 to enable this endpoint."
    };
  }

  return getSdeRecommendationAckEnvironmentGuardFailure(options);
}

function getSdeRecommendationAckEnvironmentGuardFailure(options){
  const env = options.env || process.env;
  const port = Number(options.port);
  const databasePath = options.databasePath;

  if(isFlagEnabled(env, "SDE_ENABLE_OPERATIONAL_WRITES")){
    return {
      error: "sde_recommendation_ack_operational_writes_forbidden",
      message: "SDE recommendation ack actions must not be enabled with SDE_ENABLE_OPERATIONAL_WRITES=1 in this phase."
    };
  }

  const conflictingFlag = CONFLICTING_SDE_RECOMMENDATION_ACK_FLAGS.find(flag => isFlagEnabled(env, flag));
  if(conflictingFlag){
    return {
      error: "sde_recommendation_ack_conflicting_flag",
      message: `SDE recommendation ack actions must not be combined with ${conflictingFlag}=1.`,
      flag: conflictingFlag
    };
  }

  if(isFlagEnabled(env, "SDE_ENABLE_PRODUCTION_SDE_RECOMMENDATION_ACK_ACTIONS")){
    return getProductionSdeRecommendationAckGuardFailure({ port, databasePath });
  }

  return getTestSdeRecommendationAckGuardFailure({ env, port, databasePath });
}

function getProductionSdeRecommendationAckGuardFailure(options){
  const port = Number(options.port);
  const databasePath = options.databasePath;

  if(port !== PRODUCTION_PORT || !isProductionDatabasePath(databasePath)){
    return {
      error: "sde_recommendation_ack_production_target_required",
      message: "Production SDE recommendation ack actions require production port 8787 and the production database."
    };
  }

  return null;
}

function getTestSdeRecommendationAckGuardFailure(options){
  const env = options.env || process.env;
  const port = Number(options.port);
  const databasePath = options.databasePath;

  if(port === PRODUCTION_PORT){
    return {
      error: "sde_recommendation_ack_production_port",
      message: "SDE recommendation ack actions cannot run on production port 8787 in test mode."
    };
  }

  if(!env.SDE_SERVER_DB_PATH){
    return {
      error: "sde_recommendation_ack_db_path_required",
      message: "SDE recommendation ack actions require an explicit non-production SDE_SERVER_DB_PATH."
    };
  }

  if(isProductionDatabasePath(databasePath)){
    return {
      error: "sde_recommendation_ack_production_database",
      message: "SDE recommendation ack actions cannot use the production database in test mode."
    };
  }

  if(!isTmpDatabasePath(databasePath)){
    return {
      error: "sde_recommendation_ack_tmp_database_required",
      message: "SDE recommendation ack actions require a /tmp test database in test mode."
    };
  }

  return null;
}

function getSdeRecommendationAckStatus(env = process.env){
  const sdeRecommendationAckActionsEnabled = isFlagEnabled(env, "SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS");
  return {
    sdeRecommendationAckActionsEnabled,
    sdeRecommendationAckProductionActionsEnabled: sdeRecommendationAckActionsEnabled &&
      isFlagEnabled(env, "SDE_ENABLE_PRODUCTION_SDE_RECOMMENDATION_ACK_ACTIONS")
  };
}

function isFlagEnabled(env, flagName){
  return env[flagName] === "1";
}

module.exports = {
  PRODUCTION_DB_PATH,
  PRODUCTION_PORT,
  getSdeRecommendationAckEnvironmentGuardFailure,
  getSdeRecommendationAckGuardFailure,
  getSdeRecommendationAckStatus
};
