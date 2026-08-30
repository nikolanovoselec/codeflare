import { Component } from 'solid-js';

interface AdministrationPendingPageProps {
  title: string;
  description: string;
}

const AdministrationPendingPage: Component<AdministrationPendingPageProps> = (props) => (
  <div class="admin-page">
    <header class="admin-page-header">
      <div>
        <p class="admin-eyebrow">Administration</p>
        <h1>{props.title}</h1>
        <p>{props.description}</p>
      </div>
    </header>
    <div class="admin-state-panel">
      <h2>No data available yet</h2>
      <p>This surface stays empty until its owning backend begins collecting records.</p>
    </div>
  </div>
);

export default AdministrationPendingPage;
