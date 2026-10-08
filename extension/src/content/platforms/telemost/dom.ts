import { GenericDomAdapter } from "../generic/dom";

export class TelemostDomAdapter extends GenericDomAdapter {
  protected override tileSelector = '[data-test="participant-view-block"]';
}
