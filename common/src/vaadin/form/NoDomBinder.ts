import { BinderNode } from './BinderNode';
import { _parent, AbstractModel, ModelConstructor } from './Models';
import { runValidator, ServerValidator, ValidationError, Validator, ValueError } from './Validation';

const _submitting = Symbol('submitting');
const _defaultValue = Symbol('defaultValue');
const _value = Symbol('value');
const _emptyValue = Symbol('emptyValue');
export const _onChange = Symbol('onChange');
const _onSubmit = Symbol('onSubmit');
const _validations = Symbol('validations');
const _validating = Symbol('validating');
const _validationRequestSymbol = Symbol('validationRequest');

/**
 * A Binder controls all aspects of a single form.
 * Typically it is used to get and set the form value,
 * access the form model, validate, reset, and submit the form.
 *
 * @param <T> is the type of the value that binds to a form
 * @param <M> is the type of the model that describes the structure of the value
 */
export class NoDomBinder<T, M extends AbstractModel<T>> extends BinderNode<T, M> {
  protected [_defaultValue]: T;
  protected [_value]: T;
  protected [_emptyValue]: T;
  protected [_submitting] = false;
  protected [_validating] = false;
  protected [_validationRequestSymbol]: Promise<void> | undefined = undefined;
  protected [_onChange]: (oldValue?: T) => void;
  protected [_onSubmit]: (value: T) => Promise<T | void>;

  protected [_validations]: Map<
    AbstractModel<any>,
    Map<Validator<any>, Promise<ReadonlyArray<ValueError<any>>>>
  > = new Map();

  public context: any = null;

  /**
   *
   * @param context The form view component instance to update.
   * @param Model The constructor (the class reference) of the form model. The Binder instantiates the top-level model
   * @param config The options object, which can be used to config the onChange and onSubmit callbacks.
   *
   * ```
   * binder = new Binder(OrderModel);
   * or
   * binder = new Binder(OrderModel, {onSubmit: async (order) => {endpoint.save(order)}});
   * ```
   */
  constructor(Model: ModelConstructor<T, M>, config?: BinderConfiguration<T>) {
    super(new Model({ value: undefined }, 'value', false));
    this[_emptyValue] = (this.model[_parent] as { value: T }).value;
    // @ts-ignore
    this.model[_parent] = this;

    this[_onChange] = config?.onChange || this[_onChange];
    this[_onSubmit] = config?.onSubmit || this[_onSubmit];
    this.read(this[_emptyValue]);
  }

  /**
   * The initial value of the form, before any fields are edited by the user.
   */
  get defaultValue() {
    return this[_defaultValue];
  }

  set defaultValue(newValue) {
    this[_defaultValue] = newValue;
  }

  /**
   * The current value of the form.
   */
  get value() {
    return this[_value];
  }

  set value(newValue) {
    if (newValue === this[_value]) {
      return;
    }

    const oldValue = this[_value];
    this[_value] = newValue;
    this.update(oldValue);
    this.updateValidation();
  }

  /**
   * Read the given value into the form and clear validation errors
   *
   * @param value Sets the argument as the new default
   * value before resetting, otherwise the previous default is used.
   */
  read(value: T) {
    this.defaultValue = value;
    if (
      // Skip when no value is set yet (e. g., invoked from constructor)
      this.value &&
      // Clear validation state, then proceed if update is needed
      this.clearValidation() &&
      // When value is dirty, another update is coming from invoking the value
      // setter below, so we skip this one to prevent duplicate updates
      this.value === value
    ) {
      this.update(this.value);
    }

    this.value = this.defaultValue;
  }

  /**
   * Reset the form to the previous value
   */
  reset() {
    this.read(this[_defaultValue]);
  }

  /**
   * Sets the form to empty value, as defined in the Model.
   */
  clear() {
    this.read(this[_emptyValue]);
  }

  /**
   * Submit the current form value to a predefined
   * onSubmit callback.
   *
   * It's a no-op if the onSubmit callback is undefined.
   */
  async submit(): Promise<T | void> {
    if (this[_onSubmit] !== undefined) {
      return this.submitTo(this[_onSubmit]);
    }
  }

  /**
   * Submit the current form value to callback
   *
   * @param endpointMethod the callback function
   */
  async submitTo(endpointMethod: (value: T) => Promise<T | void>): Promise<T | void> {
    const errors = await this.validate();
    if (errors.length) {
      throw new ValidationError(errors);
    }

    this[_submitting] = true;
    this.update(this.value);
    try {
      return await endpointMethod.call(this.context, this.value);
    } catch (error) {
      if (error.validationErrorData && error.validationErrorData.length) {
        const valueErrors: Array<ValueError<any>> = [];
        error.validationErrorData.forEach((data: any) => {
          const res = /Object of type '(.+)' has invalid property '(.+)' with value '(.+)', validation error: '(.+)'/.exec(
            data.message,
          );
          const [property, value, message] = res ? res.splice(2) : [data.parameterName, undefined, data.message];
          valueErrors.push({ property, value, validator: new ServerValidator(message), message });
        });
        this.setErrorsWithDescendants(valueErrors);
        error = new ValidationError(valueErrors);
        console.log(`errors:`, valueErrors);
      }
      throw error;
    } finally {
      this[_submitting] = false;
      this.defaultValue = this.value;
      this.update(this.value);
    }
  }

  async requestValidation<NT, NM extends AbstractModel<NT>>(
    model: NM,
    validator: Validator<NT>,
  ): Promise<ReadonlyArray<ValueError<NT>>> {
    let modelValidations: Map<Validator<NT>, Promise<ReadonlyArray<ValueError<NT>>>>;
    if (this[_validations].has(model)) {
      modelValidations = this[_validations].get(model) as Map<Validator<NT>, Promise<ReadonlyArray<ValueError<NT>>>>;
    } else {
      modelValidations = new Map();
      this[_validations].set(model, modelValidations);
    }

    await this.performValidation();

    if (modelValidations.has(validator)) {
      return modelValidations.get(validator) as Promise<ReadonlyArray<ValueError<NT>>>;
    }

    const promise = runValidator(model, validator);
    modelValidations.set(validator, promise);
    const valueErrors = await promise;

    modelValidations.delete(validator);
    if (modelValidations.size === 0) {
      this[_validations].delete(model);
    }
    if (this[_validations].size === 0) {
      this.completeValidation();
    }

    return valueErrors;
  }

  /**
   * Indicates the submitting status of the form.
   * True if the form was submitted, but the submit promise is not resolved yet.
   */
  get submitting() {
    return this[_submitting];
  }

  /**
   * Indicates the validating status of the form.
   * True when there is an ongoing validation.
   */
  get validating() {
    return this[_validating];
  }

  protected performValidation(): Promise<void> | void {
    if (!this[_validationRequestSymbol]) {
      this[_validating] = true;
      this[_validationRequestSymbol] = Promise.resolve().then(() => {
        this[_validationRequestSymbol] = undefined;
      });
    }
    return this[_validationRequestSymbol];
  }

  protected completeValidation() {
    this[_validating] = false;
  }

  protected update(oldValue: T) {
    if (this[_onChange]) {
      this[_onChange].call(this.context, oldValue);
    }
  }
}

export interface BinderConfiguration<T> {
  onChange?: (oldValue?: T) => void;
  onSubmit?: (value: T) => Promise<T | void>;
}
