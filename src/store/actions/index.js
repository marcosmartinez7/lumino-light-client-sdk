import * as openActions from "./open";
import * as getActions from "./get";
import * as depositActions from "./deposit";
import * as closeActions from "./close";
import * as paymentActions from "./payment";
import * as onboardingActions from "./onboarding";
import * as notifierActions from "./notifier";
import * as tokenActions from "./tokens";

const Actions = {
  ...openActions,
  ...depositActions,
  ...getActions,
  ...closeActions,
  ...paymentActions,
  ...onboardingActions,
  ...notifierActions,
  ...tokenActions,
};

export default Actions;
