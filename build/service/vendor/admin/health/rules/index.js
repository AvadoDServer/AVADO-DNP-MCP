import { appStopped, appRestarting, coreAppDown } from "./apps";
import { consensusWithoutExecution, executionWithoutConsensus, monitoringMissing, metricsUnavailable, monitoringStopped } from "./setup";
import { updatesAvailable, coreUpdateAvailable, autoupdateOff, storeUnreachable, updateBlocked } from "./updates";
import { feeRecipientMissing, twoValidatorClients } from "./validators";
import { remoteAccessMissing } from "./access";
import { diskHigh, diskFillingUp, consensusTooBig } from "./storage";
import { diagnoseFailed } from "./core";
import { chainSyncing, chainError, headBehind, lowPeers, missedAttestations } from "./chain";

// portsClosed, noUpnp and noNatLoopback (./access) are left out: the core no
// longer sends the router params they read (DAPPMANAGER getParams has
// upnpAvailable, noNatLoopback and alertToOpenPorts commented out), so they
// could only ever be counted as checks that passed. Add them back here if
// the core starts sending those params again.
export const ALL_RULES = [
  appStopped, appRestarting, coreAppDown,
  consensusWithoutExecution, executionWithoutConsensus, monitoringMissing, metricsUnavailable, monitoringStopped,
  updatesAvailable, coreUpdateAvailable, autoupdateOff, storeUnreachable, updateBlocked,
  feeRecipientMissing, twoValidatorClients,
  remoteAccessMissing,
  diskHigh, diskFillingUp, consensusTooBig, diagnoseFailed,
  chainSyncing, chainError, headBehind, lowPeers, missedAttestations,
];
