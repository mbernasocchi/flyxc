import { css, CSSResult, customElement, html, LitElement, property, TemplateResult } from 'lit-element';

@customElement('text-field')
export class TextField extends LitElement {
  static version = 'vaadin';

  @property()
  label?: string;

  @property({ attribute: false })
  invalid = false;

  @property({ attribute: false })
  errorMessage = '';

  @property({ attribute: false })
  value = '';

  static get styles(): CSSResult {
    return css`
      .field {
        display: block;
        margin-bottom: 0.5rem;
      }
    `;
  }

  protected render(): TemplateResult {
    return html`
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@0.9.0/css/bulma.min.css" />
      <div class="field">
        <label class="label">${this.label}</label>
        <div class="control">
          <input
            @input=${this.handleInput}
            class=${`input ${this.errorMessage ? 'is-danger' : ''}`}
            type="text"
            value=${this.value}
          />
        </div>
        ${this.errorMessage ? html`<p class="help is-danger">${this.errorMessage}</p>` : null}
      </div>
    `;
  }

  private handleInput(e: InputEvent) {
    const input = e.target as HTMLInputElement;
    this.value = input.value;
  }
}
