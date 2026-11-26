export class Logger {
  write(msg) {
    return msg;
  }
}

export class Store {
  #items = [];
  #count = 0;
  #logger = new Logger();

  static #create() {
    return new Store();
  }

  static make() {
    return Store.#create();
  }

  #log(msg) {
    return this.#logger.write(msg);
  }

  #bump() {
    this.#count += 1;
  }

  add(item) {
    this.#items.push(item);
    this.#log('added');
  }

  reset() {
    this.#count = 0;
    this.#bump();
  }

  async #load() {
    return this.#count;
  }

  async refresh() {
    return await this.#load();
  }

  async reload() {
    return await this.#load<number>();
  }
}

export class Queue {
  #bump() {
    return 1;
  }

  push() {
    return this.#bump();
  }
}

export class Button {
  #onClick = () => 1;
  #onPress = function () {
    return 2;
  };

  click() {
    return this.#onClick();
  }

  press() {
    return this.#onPress();
  }
}
