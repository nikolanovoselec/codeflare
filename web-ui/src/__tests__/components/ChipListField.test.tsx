import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import ChipListField from '../../components/ui/ChipListField';

// Input renders an Icon only when given one; mock it so the import is side-effect free.
vi.mock('../../components/Icon', () => ({
  default: (props: { path: string }) => <span data-testid="mock-icon" data-path={props.path} />,
}));

afterEach(() => cleanup());

describe('ChipListField', () => {
  it('renders one chip per item', () => {
    render(() => <ChipListField label="L" items={['a', 'b', 'c']} onAdd={() => true} onRemove={() => {}} />);
    expect(document.querySelectorAll('.email-tag').length).toBe(3);
  });

  it('applies the accent chip class only when accent is set', () => {
    render(() => <ChipListField label="L" items={['a']} accent onAdd={() => true} onRemove={() => {}} />);
    expect(document.querySelector('.email-tag--accent')).not.toBeNull();
    cleanup();
    render(() => <ChipListField label="L" items={['a']} onAdd={() => true} onRemove={() => {}} />);
    expect(document.querySelector('.email-tag--accent')).toBeNull();
  });

  it('calls onAdd with the typed value on Add click and clears the input when accepted', () => {
    const onAdd = vi.fn(() => true);
    render(() => <ChipListField label="L" items={[]} placeholder="type" onAdd={onAdd} onRemove={() => {}} />);
    const input = screen.getByPlaceholderText('type') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Add'));
    expect(onAdd).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('keeps the input value when onAdd rejects (returns false)', () => {
    const onAdd = vi.fn(() => false);
    render(() => <ChipListField label="L" items={[]} placeholder="type" onAdd={onAdd} onRemove={() => {}} />);
    const input = screen.getByPlaceholderText('type') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'bad' } });
    fireEvent.click(screen.getByText('Add'));
    expect(onAdd).toHaveBeenCalledWith('bad');
    expect(input.value).toBe('bad');
  });

  it('adds on Enter key', () => {
    const onAdd = vi.fn(() => true);
    render(() => <ChipListField label="L" items={[]} placeholder="type" onAdd={onAdd} onRemove={() => {}} />);
    const input = screen.getByPlaceholderText('type');
    fireEvent.input(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('x');
  });

  it('calls onRemove with the chip value on the x button', () => {
    const onRemove = vi.fn();
    render(() => <ChipListField label="L" items={['a']} onAdd={() => true} onRemove={onRemove} />);
    fireEvent.click(document.querySelector('.email-tag-remove') as HTMLElement);
    expect(onRemove).toHaveBeenCalledWith('a');
  });
});
