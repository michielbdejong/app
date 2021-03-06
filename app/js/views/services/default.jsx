import React from 'components/react';

import NavigationMenu from 'js/views/navigation-menu';
import TagList from 'js/views/tag-list';

export default class Service extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      data: props.service.tags,
      tags: []
    };

    this.foxbox = props.foxbox;
    this.service = props.service;

    this.onServiceStateChanged = this.onServiceStateChanged.bind(this);
  }

  componentDidMount() {
    this.populateTags();

    this.foxbox.addEventListener(
      'service-state-change', this.onServiceStateChanged
    );
  }

  componentWillUnmount() {
    this.foxbox.removeEventListener(
      'service-state-change', this.onServiceStateChanged
    );
  }

  onServiceStateChanged(service) {
    if (service.id !== this.props.id) {
      return;
    }

    this.service = service;
    this.setState({ data: service.tags });
  }

  populateTags() {
    this.foxbox.getTags()
      .then(tags => {
        tags.forEach(tag => {
          tag.data.checked = !!(this.state.data &&
            this.state.data.includes(tag.id));
        });

        this.setState({ tags });
      });
  }

  handleAddTag() {
    let name = prompt('Enter new tag name');

    if (!name || !name.trim()) {
      return;
    }

    name = name.trim();
    this.foxbox.setTag({ name })
      .then(() => {
        this.populateTags(); // Needed to get the newly added tag ID.
      });
  }

  render() {
    return (
      <div className="app-view">
        <header className="app-view__header">
          <h1>{this.service.properties.name}</h1>
        </header>
        <section className="app-view__body">
          <h2>Tags</h2>
          <TagList tags={this.state.tags} serviceId={this.service.id}
                   foxbox={this.foxbox}/>
        </section>
        <button className="add-tag-button" type="button"
                onClick={this.handleAddTag.bind(this)}>
          Create a new tag
        </button>
        <footer className="app-view__footer">
          <NavigationMenu foxbox={this.foxbox}/>
        </footer>
      </div>
    );
  }
}

Service.propTypes = {
  foxbox: React.PropTypes.object.isRequired,
  service: React.PropTypes.object.isRequired,
  id: React.PropTypes.string.isRequired
};
