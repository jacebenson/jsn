import showcases from "./showcases.js";

const order = ["Explore", "Diagnose", "Change", "Automate", "Verify", "Connect", "Extend"];
export default order.map((name) => ({
  name,
  features: showcases.filter((feature) => feature.group === name),
})).filter((group) => group.features.length);
