import { GenericDomAdapter } from "../generic/dom";

export class GoogleMeetDomAdapter extends GenericDomAdapter {
  protected override tileSelector = "[data-participant-id]";

  constructor() {
    super();
    this.nameSelector = `span.notranslate, ${this.nameSelector}`;
  }
}
