import { GenericDomAdapter } from "../generic/dom";

export class WbStreamDomAdapter extends GenericDomAdapter {
  protected override tileSelector = "[data-lk-participant-identity], .lk-participant-tile";

  constructor() {
    super();
    this.nameSelector = `[data-lk-participant-name], ${this.nameSelector}`;
    this.localSelector = `[data-lk-local-participant="true"], ${this.localSelector}`;
  }
}
